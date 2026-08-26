/**
 * Availability service — turns stored timeslots into customer-facing availability,
 * and generates new timeslots for a date range.
 *
 * Times are stored in the DB as UTC instants; each operator renders/operates in its
 * own IANA timezone (Operator.timezone, optionally overridden per Location). All the
 * "what day is it" math here is therefore done in the operator's timezone so a slot at
 * 9:00 AM local lands on the correct calendar day regardless of the server's locale.
 *
 * Capacity status is derived via @marina/core computeSlotStatus so the rule
 * (AVAILABLE / FILLING_UP / FULL) stays identical everywhere it is shown.
 *
 * Availability must never lie: what the calendar shows is the SAME number the booking
 * service will enforce (D-014 shared resources). A slot whose boat is already out on a
 * different activity comes back unavailable here, with a reason, instead of being sold
 * and then refused at checkout.
 */
import { computeSlotStatus, generateTimeslots, type SlotStatus } from '@marina/core';
import type { Prisma, TenantClient } from '@marina/database';
import { activityResourcePools, poolSeats } from './resources.js';

/**
 * Why a slot's true capacity is lower than its own timeslot capacity — i.e. a shared
 * resource pool is the binding constraint, not the slot. Absent when the slot's own
 * capacity is what limits it, so the UI can tell "we're full" from "the boat is out".
 */
export interface CapacityLimit {
  kind: 'RESOURCE';
  resourceId: string;
  resourceName: string;
  /** Seats the pool can still support in this slot's window (never negative). */
  remaining: number;
  /** Short, customer-safe sentence the UI can render verbatim. */
  reason: string;
}

/** Customer-facing view of a single bookable timeslot. */
export interface TimeslotView {
  id: string;
  /** UTC instant of the slot start, ISO-8601. */
  datetime: string;
  capacityTotal: number;
  capacityBooked: number;
  capacityRemaining: number;
  status: SlotStatus;
  isOvernight: boolean;
  /** True when at least one seat can actually be booked right now. */
  available: boolean;
  /** Set only when a shared resource — not this slot's capacity — is the constraint. */
  limitedBy: CapacityLimit | null;
  /** Why the slot can't be booked; null when it can. */
  unavailableReason: string | null;
}

/** Per-day availability rollup used by calendars / month views. */
export interface DayAvailability {
  /** Calendar day in the operator timezone, YYYY-MM-DD. */
  date: string;
  /** Number of non-cancelled slots on that day. */
  slotCount: number;
  capacityTotal: number;
  capacityBooked: number;
  capacityRemaining: number;
  /**
   * Traffic-light summary for the day:
   *  - 'red'    nothing bookable (no slots, or every slot full)
   *  - 'yellow' some availability but the day is filling up
   *  - 'green'  comfortably available
   */
  signal: 'green' | 'yellow' | 'red';
  /** True when a shared resource, not the day's own slot capacity, held anything back. */
  resourceLimited: boolean;
}

export class AvailabilityError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AvailabilityError';
    this.status = status;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a YYYY-MM-DD string into its numeric parts, validating the shape. */
function parseDateParts(value: string, field: string): { y: number; m: number; d: number } {
  if (!DATE_RE.test(value)) {
    throw new AvailabilityError(`${field} must be a YYYY-MM-DD date`);
  }
  const [y, m, d] = value.split('-').map(Number);
  // Reject impossible calendar values (e.g. 2026-13-40).
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new AvailabilityError(`${field} is not a valid calendar date`);
  }
  return { y, m, d };
}

/**
 * Offset (in minutes) of a given IANA timezone from UTC at a specific UTC instant.
 * Positive means the zone is ahead of UTC. Uses Intl so no extra dependency is needed
 * and DST transitions are honoured.
 */
function tzOffsetMinutes(timeZone: string, atUtc: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(atUtc);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - atUtc.getTime()) / 60000);
}

/**
 * Convert a wall-clock time in `timeZone` (the components of `local`) to the
 * corresponding UTC instant. The components of `local` are interpreted as if they were
 * the local time in `timeZone`. Resolves DST by re-deriving the offset at the candidate
 * instant (a standard two-pass correction).
 */
function zonedWallTimeToUtc(timeZone: string, local: Date): Date {
  const naiveUtc = Date.UTC(
    local.getFullYear(),
    local.getMonth(),
    local.getDate(),
    local.getHours(),
    local.getMinutes(),
    local.getSeconds(),
    local.getMilliseconds(),
  );
  const firstOffset = tzOffsetMinutes(timeZone, new Date(naiveUtc));
  const firstGuess = naiveUtc - firstOffset * 60000;
  const secondOffset = tzOffsetMinutes(timeZone, new Date(firstGuess));
  return new Date(naiveUtc - secondOffset * 60000);
}

/** The UTC instants bounding a calendar day [start, end) in the given timezone. */
function dayBoundsUtc(
  timeZone: string,
  parts: { y: number; m: number; d: number },
): { start: Date; end: Date } {
  const start = zonedWallTimeToUtc(timeZone, new Date(parts.y, parts.m - 1, parts.d, 0, 0, 0, 0));
  const end = zonedWallTimeToUtc(timeZone, new Date(parts.y, parts.m - 1, parts.d + 1, 0, 0, 0, 0));
  return { start, end };
}

/** YYYY-MM-DD for a UTC instant rendered in the given timezone. */
function dayKey(timeZone: string, instant: Date): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(instant); // en-CA yields YYYY-MM-DD
}

/**
 * Resolve the timezone an activity operates in: its location override, falling back to
 * the operator timezone. Returns the operator timezone if the activity has no location.
 */
async function resolveActivityTimezone(db: TenantClient, activityId: string): Promise<string> {
  const activity = await db.activity.findUnique({
    where: { id: activityId },
    select: {
      operator: { select: { timezone: true } },
      location: { select: { timezone: true } },
    },
  });
  if (!activity) {
    throw new AvailabilityError('Activity not found', 404);
  }
  return activity.location?.timezone ?? activity.operator.timezone;
}

/**
 * The set of blackout calendar days (YYYY-MM-DD, operator/location timezone) that
 * overlap [rangeStart, rangeEnd). A blackout scoped to a location applies only when
 * the activity belongs to that location; unscoped (location_id null) blackouts apply
 * everywhere. Availability queries drop any slot whose day is in this set.
 */
async function blackoutDayKeys(
  db: TenantClient,
  activityId: string,
  timeZone: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<Set<string>> {
  const activity = await db.activity.findUnique({
    where: { id: activityId },
    select: { location_id: true },
  });
  const locationId = activity?.location_id ?? null;

  const rows = await db.blackoutDate.findMany({
    where: {
      date: { gte: startOfDay(rangeStart), lt: rangeEnd },
      OR: [{ location_id: null }, ...(locationId ? [{ location_id: locationId }] : [])],
    },
    select: { date: true },
  });

  const keys = new Set<string>();
  for (const r of rows) keys.add(dayKey(timeZone, r.date));
  return keys;
}

/** UTC-midnight of the day containing `d`, so a blackout stored at midnight is caught. */
function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---------------------------------------------------------------------------
// True capacity — the intersection of a timeslot's own capacity with what the
// shared resource pools can still honour in that slot's window.
//
// The math is deliberately pure (epoch-ms in, numbers out) and exported so it can be
// unit-tested without a database, and so the same rule can be reused anywhere.
// ---------------------------------------------------------------------------

/** One reservation held against a pool, reduced to what the intersection math needs. */
export interface ResourceReservation {
  /** Epoch ms, inclusive. */
  startsAt: number;
  /** Epoch ms, exclusive — matches the half-open overlap the booking service enforces. */
  endsAt: number;
  seats: number;
}

/**
 * A resource pool plus its reservations pre-indexed for O(log n) window lookups.
 * Built once per availability request; queried once per slot. That is what keeps a
 * month view from turning into a query per slot per pool.
 */
export interface PoolLedger {
  id: string;
  name: string;
  /** Seats the pool can sell at one instant (out-of-service units already removed). */
  totalSeats: number;
  /** Reservation starts ascending, with the running seat total aligned to them. */
  startsAsc: number[];
  startsCum: number[];
  /** Reservation ends ascending, with their own running seat total. */
  endsAsc: number[];
  endsCum: number[];
}

/** Number of entries strictly less than `x` in an ascending array. */
function countBelow(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Number of entries less than or equal to `x` in an ascending array. */
function countAtOrBelow(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index a pool's reservations so any window's reserved seats is two binary searches. */
export function buildPoolLedger(
  pool: { id: string; name: string; totalSeats: number },
  reservations: ResourceReservation[],
): PoolLedger {
  const byStart = [...reservations].sort((a, b) => a.startsAt - b.startsAt);
  const byEnd = [...reservations].sort((a, b) => a.endsAt - b.endsAt);

  const startsAsc: number[] = [];
  const startsCum: number[] = [0];
  for (const r of byStart) {
    startsAsc.push(r.startsAt);
    startsCum.push(startsCum[startsCum.length - 1] + r.seats);
  }
  const endsAsc: number[] = [];
  const endsCum: number[] = [0];
  for (const r of byEnd) {
    endsAsc.push(r.endsAt);
    endsCum.push(endsCum[endsCum.length - 1] + r.seats);
  }

  return {
    id: pool.id,
    name: pool.name,
    totalSeats: pool.totalSeats,
    startsAsc,
    startsCum,
    endsAsc,
    endsCum,
  };
}

/**
 * Seats reserved on a pool by everything overlapping [startsAt, endsAt) — identical to
 * what `reservedSeats` computes in SQL, but without a round trip.
 *
 * Overlap is `start < windowEnd AND end > windowStart`. Every reservation that ended at
 * or before the window began necessarily also started before the window ended, so the
 * overlapping set is exactly {started before the end} minus {ended at or before the
 * start} — two prefix sums. The identity holds for a zero-length window too (an
 * activity with no rate duration), where it degrades to "reservations strictly
 * spanning the instant" — again exactly what the SQL does.
 */
export function seatsReservedIn(ledger: PoolLedger, startsAt: number, endsAt: number): number {
  const started = ledger.startsCum[countBelow(ledger.startsAsc, endsAt)];
  const finished = ledger.endsCum[countAtOrBelow(ledger.endsAsc, startsAt)];
  return started - finished;
}

/** The capacity numbers a customer is actually allowed to see for one slot. */
export interface TrueCapacity {
  /** Booked count re-expressed against capacityTotal so the status rule stays coherent. */
  capacityBooked: number;
  capacityRemaining: number;
  status: SlotStatus;
  available: boolean;
  limitedBy: CapacityLimit | null;
  unavailableReason: string | null;
}

/** Customer-safe sentence for a pool that is the binding constraint. */
function limitReason(name: string, totalSeats: number, remaining: number): string {
  if (remaining > 0) return `Only ${remaining} left of ${name}`;
  return totalSeats <= 0 ? `${name} is out of service` : `${name} already out`;
}

/**
 * TRUE remaining capacity for one slot: the MIN of the timeslot's own remaining
 * capacity and every pool's free seats for the slot's window. A pool only becomes the
 * reported `limitedBy` when it is STRICTLY tighter than the slot itself — otherwise the
 * slot's own capacity is the honest explanation. Ties keep the first pool, so the
 * message is stable across calls (callers pass pools in a deterministic order).
 */
export function resolveTrueCapacity(input: {
  capacityTotal: number;
  capacityBooked: number;
  pools: PoolLedger[];
  /** Slot window, epoch ms; endsAt is exclusive. */
  startsAt: number;
  endsAt: number;
}): TrueCapacity {
  let remaining = input.capacityTotal - input.capacityBooked;
  let limitedBy: CapacityLimit | null = null;

  for (const pool of input.pools) {
    const free = pool.totalSeats - seatsReservedIn(pool, input.startsAt, input.endsAt);
    if (free < remaining) {
      remaining = free;
      limitedBy = {
        kind: 'RESOURCE',
        resourceId: pool.id,
        resourceName: pool.name,
        remaining: Math.max(0, free),
        reason: limitReason(pool.name, pool.totalSeats, Math.max(0, free)),
      };
    }
  }

  const capacityRemaining = Math.max(0, remaining);
  // Re-express whatever the constraint was as a booked count against the same total, so
  // the status rule and the remaining number can never disagree. An already-overbooked
  // slot keeps its real (higher) count — that anomaly is something staff must still see.
  const capacityBooked = Math.max(input.capacityBooked, input.capacityTotal - capacityRemaining);
  const available = capacityRemaining > 0;
  return {
    capacityBooked,
    capacityRemaining,
    status: computeSlotStatus(input.capacityTotal, capacityBooked),
    available,
    limitedBy,
    unavailableReason: available ? null : (limitedBy?.reason ?? 'Fully booked'),
  };
}

function toView(
  slot: {
    id: string;
    datetime: Date;
    capacity_total: number;
    capacity_booked: number;
    is_overnight: boolean;
  },
  pools: PoolLedger[],
  durationMs: number,
): TimeslotView {
  const startsAt = slot.datetime.getTime();
  const cap = resolveTrueCapacity({
    capacityTotal: slot.capacity_total,
    capacityBooked: slot.capacity_booked,
    pools,
    startsAt,
    endsAt: startsAt + durationMs,
  });
  return {
    id: slot.id,
    datetime: slot.datetime.toISOString(),
    capacityTotal: slot.capacity_total,
    capacityBooked: cap.capacityBooked,
    capacityRemaining: cap.capacityRemaining,
    status: cap.status,
    isOvernight: slot.is_overnight,
    available: cap.available,
    limitedBy: cap.limitedBy,
    unavailableReason: cap.unavailableReason,
  };
}

/**
 * Available timeslots for one activity on one calendar day (operator timezone).
 * Cancelled slots are excluded. Slots are returned in chronological order with a
 * derived capacity status; fully-booked slots are still returned (status FULL) so the
 * UI can show them greyed out rather than silently hiding the time.
 */
export async function getDayAvailability(
  db: TenantClient,
  params: { activityId: string; date: string },
): Promise<{ activityId: string; date: string; timezone: string; timeslots: TimeslotView[] }> {
  const parts = parseDateParts(params.date, 'date');
  const timeZone = await resolveActivityTimezone(db, params.activityId);
  const { start, end } = dayBoundsUtc(timeZone, parts);

  // Blackout days (Singenuity §4): if this calendar day is blacked out, no slots are
  // bookable — return an empty set without even loading the timeslots.
  const blackout = await blackoutDayKeys(db, params.activityId, timeZone, start, end);
  if (blackout.has(params.date)) {
    return { activityId: params.activityId, date: params.date, timezone: timeZone, timeslots: [] };
  }

  const slots = await db.timeslot.findMany({
    where: {
      activity_id: params.activityId,
      status: { not: 'CANCELLED' },
      datetime: { gte: start, lt: end },
    },
    orderBy: { datetime: 'asc' },
    select: {
      id: true,
      datetime: true,
      capacity_total: true,
      capacity_booked: true,
      is_overnight: true,
    },
  });

  const { pools, durationMs } = await loadPoolLedgers(db, params.activityId, start, end);
  const timeslots = slots.map((slot) => toView(slot, pools, durationMs));

  return {
    activityId: params.activityId,
    date: params.date,
    timezone: timeZone,
    timeslots,
  };
}

/**
 * Load every shared pool an activity draws from, together with all reservations that
 * could touch any slot start in [rangeStart, rangeEnd), indexed for window lookups.
 *
 * THREE queries at most, whatever the slot count: the pools, the longest rate, and one
 * batched read of the reservations across all pools. The per-slot work afterwards is
 * pure arithmetic, so a month view costs the same round trips as a single day.
 *
 * The window uses the activity's LONGEST active rate duration: the conservative choice,
 * so the display never over-promises a slot that a long booking would then be refused.
 * Booking-time enforcement in the booking service stays authoritative.
 */
async function loadPoolLedgers(
  db: TenantClient,
  activityId: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<{ pools: PoolLedger[]; durationMs: number }> {
  // The resource helpers accept a transaction client; the extended tenant client has
  // the same delegates at runtime but a different (dynamic-extension) static type, so
  // bridge it here once. Reads only — no writes happen on this path.
  const rdb = db as unknown as Prisma.TransactionClient;

  const pools = await activityResourcePools(rdb, activityId);
  if (pools.length === 0) return { pools: [], durationMs: 0 };

  const longestRate = await db.rate.findFirst({
    where: { activity_id: activityId, is_active: true },
    orderBy: { duration_minutes: 'desc' },
    select: { duration_minutes: true },
  });
  const durationMs = (longestRate?.duration_minutes ?? 0) * 60_000;

  // Every slot window sits inside [rangeStart, rangeEnd + duration); a reservation
  // outside that span cannot overlap any of them, so it never has to be loaded.
  const spanEnd = new Date(rangeEnd.getTime() + durationMs);
  const rows = await rdb.resourceBooking.findMany({
    where: {
      resource_id: { in: pools.map((p) => p.id) },
      starts_at: { lt: spanEnd },
      ends_at: { gt: rangeStart },
    },
    select: { resource_id: true, seats: true, starts_at: true, ends_at: true },
  });

  const byPool = new Map<string, ResourceReservation[]>();
  for (const row of rows) {
    const list = byPool.get(row.resource_id);
    const entry = {
      startsAt: row.starts_at.getTime(),
      endsAt: row.ends_at.getTime(),
      seats: row.seats,
    };
    if (list) list.push(entry);
    else byPool.set(row.resource_id, [entry]);
  }

  // Sort by name so the "which pool is the constraint" message is stable between calls
  // (Prisma gives no ordering guarantee, and ties resolve to the first pool).
  const ledgers = [...pools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((pool) =>
      buildPoolLedger(
        { id: pool.id, name: pool.name, totalSeats: poolSeats(pool) },
        byPool.get(pool.id) ?? [],
      ),
    );

  return { pools: ledgers, durationMs };
}

/** Inclusive-of-both-ends span between two YYYY-MM-DD dates, capped for safety. */
const MAX_RANGE_DAYS = 366;

/**
 * Per-day availability summary across a date range [from, to] (both inclusive,
 * operator timezone). Used by month/range calendar views to colour each day.
 */
export async function getRangeAvailability(
  db: TenantClient,
  params: { activityId: string; from: string; to: string },
): Promise<{
  activityId: string;
  from: string;
  to: string;
  timezone: string;
  days: DayAvailability[];
}> {
  const fromParts = parseDateParts(params.from, 'from');
  const toParts = parseDateParts(params.to, 'to');
  const timeZone = await resolveActivityTimezone(db, params.activityId);

  const rangeStart = dayBoundsUtc(timeZone, fromParts).start;
  const rangeEnd = dayBoundsUtc(timeZone, toParts).end; // exclusive upper bound
  if (rangeEnd.getTime() <= rangeStart.getTime()) {
    throw new AvailabilityError('`to` must be on or after `from`');
  }
  const approxDays = Math.round((rangeEnd.getTime() - rangeStart.getTime()) / 86_400_000);
  if (approxDays > MAX_RANGE_DAYS) {
    throw new AvailabilityError(`Range too large (max ${MAX_RANGE_DAYS} days)`);
  }

  const [slots, blackout, resources] = await Promise.all([
    db.timeslot.findMany({
      where: {
        activity_id: params.activityId,
        status: { not: 'CANCELLED' },
        datetime: { gte: rangeStart, lt: rangeEnd },
      },
      orderBy: { datetime: 'asc' },
      select: {
        datetime: true,
        capacity_total: true,
        capacity_booked: true,
      },
    }),
    blackoutDayKeys(db, params.activityId, timeZone, rangeStart, rangeEnd),
    loadPoolLedgers(db, params.activityId, rangeStart, rangeEnd),
  ]);

  interface DayBucket {
    slotCount: number;
    capacityTotal: number;
    capacityBooked: number;
    resourceLimited: boolean;
  }
  const emptyBucket = (): DayBucket => ({
    slotCount: 0,
    capacityTotal: 0,
    capacityBooked: 0,
    resourceLimited: false,
  });

  // Seed every calendar day in the range so days with no slots still appear (red).
  const buckets = new Map<string, DayBucket>();
  for (
    let cursor = new Date(rangeStart.getTime());
    cursor.getTime() < rangeEnd.getTime();

  ) {
    const key = dayKey(timeZone, cursor);
    if (!buckets.has(key)) {
      buckets.set(key, emptyBucket());
    }
    // Advance ~1 day; dayKey collapses any DST drift to the right calendar date.
    cursor = new Date(cursor.getTime() + 86_400_000);
  }

  for (const slot of slots) {
    const key = dayKey(timeZone, slot.datetime);
    const bucket = buckets.get(key) ?? emptyBucket();
    // Roll up TRUE capacity, not the optimistic timeslot numbers: a day whose boats are
    // all committed elsewhere has to come back red, not green with phantom spots. The
    // sum still slightly over-counts when two slots of the same day share one pool, but
    // it is exact at the boundary that matters — zero bookable means zero.
    const startsAt = slot.datetime.getTime();
    const cap = resolveTrueCapacity({
      capacityTotal: slot.capacity_total,
      capacityBooked: slot.capacity_booked,
      pools: resources.pools,
      startsAt,
      endsAt: startsAt + resources.durationMs,
    });
    bucket.slotCount += 1;
    bucket.capacityTotal += slot.capacity_total;
    bucket.capacityBooked += cap.capacityBooked;
    if (cap.limitedBy) bucket.resourceLimited = true;
    buckets.set(key, bucket);
  }

  const days: DayAvailability[] = [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, b]) => {
      const isBlackout = blackout.has(date);
      const remaining = isBlackout ? 0 : Math.max(0, b.capacityTotal - b.capacityBooked);
      // A day is red when nothing can be booked (including an operator blackout).
      // Otherwise reuse the slot-status rule on the day's aggregate capacity:
      // FULL/-ish -> red, FILLING_UP -> yellow, else green.
      let signal: DayAvailability['signal'];
      if (isBlackout || b.slotCount === 0 || remaining <= 0) {
        signal = 'red';
      } else {
        const status = computeSlotStatus(b.capacityTotal, b.capacityBooked);
        signal = status === 'FULL' ? 'red' : status === 'FILLING_UP' ? 'yellow' : 'green';
      }
      return {
        date,
        slotCount: b.slotCount,
        capacityTotal: b.capacityTotal,
        capacityBooked: b.capacityBooked,
        capacityRemaining: remaining,
        signal,
        resourceLimited: b.resourceLimited,
      };
    });

  return { activityId: params.activityId, from: params.from, to: params.to, timezone: timeZone, days };
}

export interface GenerateParams {
  /**
   * The tenant the slots belong to. RLS scopes access by the session GUC, but Prisma
   * still requires the non-null `operator_id` column on insert, so it is set explicitly
   * on every row. It must match the authenticated operator (the caller passes
   * c.var.operatorId) — RLS rejects any write whose operator_id differs from the GUC.
   */
  operatorId: string;
  activityId: string;
  from: string;
  to: string;
  openHour: number;
  closeHour: number;
  intervalMinutes: number;
  capacityTotal: number;
  /** When true (default), days that already have slots are skipped (idempotent). */
  skipExistingDays?: boolean;
  isOvernight?: boolean;
}

/**
 * Generate timeslots for an activity across a date range. For each calendar day in
 * [from, to] it builds evenly-spaced slots with @marina/core generateTimeslots, then
 * converts each local wall-clock start to the correct UTC instant before persisting.
 *
 * Idempotent by default: any day that already has at least one non-cancelled slot is
 * left untouched, so re-running won't create duplicates. Returns counts so the caller
 * can report what happened.
 */
export async function generateTimeslotsForRange(
  db: TenantClient,
  params: GenerateParams,
): Promise<{
  activityId: string;
  timezone: string;
  created: number;
  daysGenerated: number;
  daysSkipped: number;
}> {
  if (params.closeHour <= params.openHour) {
    throw new AvailabilityError('closeHour must be greater than openHour');
  }
  if (params.intervalMinutes <= 0) {
    throw new AvailabilityError('intervalMinutes must be positive');
  }
  if (params.capacityTotal <= 0) {
    throw new AvailabilityError('capacityTotal must be positive');
  }

  const fromParts = parseDateParts(params.from, 'from');
  const toParts = parseDateParts(params.to, 'to');
  const timeZone = await resolveActivityTimezone(db, params.activityId);

  const rangeStart = dayBoundsUtc(timeZone, fromParts).start;
  const rangeEnd = dayBoundsUtc(timeZone, toParts).end; // exclusive
  if (rangeEnd.getTime() <= rangeStart.getTime()) {
    throw new AvailabilityError('`to` must be on or after `from`');
  }
  const approxDays = Math.round((rangeEnd.getTime() - rangeStart.getTime()) / 86_400_000);
  if (approxDays > MAX_RANGE_DAYS) {
    throw new AvailabilityError(`Range too large (max ${MAX_RANGE_DAYS} days)`);
  }

  const skipExisting = params.skipExistingDays ?? true;

  // Pre-load existing day keys so we can skip them without a query per day.
  const existingDayKeys = new Set<string>();
  if (skipExisting) {
    const existing = await db.timeslot.findMany({
      where: {
        activity_id: params.activityId,
        status: { not: 'CANCELLED' },
        datetime: { gte: rangeStart, lt: rangeEnd },
      },
      select: { datetime: true },
    });
    for (const s of existing) existingDayKeys.add(dayKey(timeZone, s.datetime));
  }

  const rows: Array<{
    operator_id: string;
    activity_id: string;
    datetime: Date;
    capacity_total: number;
    is_overnight: boolean;
  }> = [];
  let daysGenerated = 0;
  let daysSkipped = 0;

  // Iterate each calendar day by its YYYY-MM-DD key (DST-safe).
  for (
    let cursor = new Date(rangeStart.getTime());
    cursor.getTime() < rangeEnd.getTime();
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    const key = dayKey(timeZone, cursor);
    if (skipExisting && existingDayKeys.has(key)) {
      daysSkipped += 1;
      continue;
    }
    const [ky, km, kd] = key.split('-').map(Number);
    const generated = generateTimeslots({
      openHour: params.openHour,
      closeHour: params.closeHour,
      intervalMinutes: params.intervalMinutes,
      // Local calendar day; only the date portion is used by generateTimeslots.
      date: new Date(ky, km - 1, kd, 0, 0, 0, 0),
      capacityTotal: params.capacityTotal,
    });
    if (generated.length === 0) continue;
    for (const slot of generated) {
      rows.push({
        operator_id: params.operatorId,
        activity_id: params.activityId,
        datetime: zonedWallTimeToUtc(timeZone, slot.datetime),
        capacity_total: slot.capacityTotal,
        is_overnight: params.isOvernight ?? false,
      });
    }
    daysGenerated += 1;
    // Guard against re-seeding the same day twice within this run.
    existingDayKeys.add(key);
  }

  let created = 0;
  if (rows.length > 0) {
    // Each row carries operator_id explicitly (required column); the RLS GUC set by the
    // tenant client guarantees the insert cannot land in another tenant's scope.
    const result = await db.timeslot.createMany({ data: rows });
    created = result.count;
  }

  return {
    activityId: params.activityId,
    timezone: timeZone,
    created,
    daysGenerated,
    daysSkipped,
  };
}
