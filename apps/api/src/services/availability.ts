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
 */
import { computeSlotStatus, generateTimeslots, type SlotStatus } from '@marina/core';
import type { TenantClient } from '@marina/database';
import { getResourceConstraints } from './resource-availability.js';

/** Customer-facing view of a single bookable timeslot. */
export interface TimeslotView {
  id: string;
  /** UTC instant of the slot start, ISO-8601. */
  datetime: string;
  capacityTotal: number;
  capacityBooked: number;
  /**
   * Spots a customer can actually book — the lesser of the slot's own remaining and any
   * shared-resource pool remaining (a backing asset consumed by a concurrent sibling
   * activity reduces this below the slot's own free seats).
   */
  capacityRemaining: number;
  status: SlotStatus;
  isOvernight: boolean;
  /** True when a shared resource — not the slot's own capacity — is the binding limit. */
  resourceConstrained: boolean;
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

function toView(
  slot: {
    id: string;
    datetime: Date;
    capacity_total: number;
    capacity_booked: number;
    is_overnight: boolean;
  },
  /** Shared-resource pool remaining at this slot, or null when no resource constrains it. */
  resourceRemaining: number | null,
): TimeslotView {
  const ownRemaining = Math.max(0, slot.capacity_total - slot.capacity_booked);
  const resourceConstrained = resourceRemaining !== null && resourceRemaining < ownRemaining;
  const effectiveRemaining = resourceConstrained ? resourceRemaining : ownRemaining;
  // Drive the traffic-light off the EFFECTIVE remaining so a slot the shared asset has
  // fully committed reads FULL even though its own seats are open.
  const effectiveBooked = slot.capacity_total - effectiveRemaining;
  return {
    id: slot.id,
    datetime: slot.datetime.toISOString(),
    capacityTotal: slot.capacity_total,
    capacityBooked: slot.capacity_booked,
    capacityRemaining: effectiveRemaining,
    status: computeSlotStatus(slot.capacity_total, effectiveBooked),
    isOvernight: slot.is_overnight,
    resourceConstrained,
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

  // Overlay shared-resource availability: a backing asset consumed by a concurrent
  // sibling activity reduces what's actually bookable here. One batched lookup for the
  // whole day; a no-resource activity comes back all-null (own capacity unchanged).
  // This read is rate-agnostic (no rate chosen yet), so we size the candidate window
  // with the activity's LONGEST active rate — the conservative window, so a slot the
  // asset could conflict with at its longest booking is shown constrained.
  const durAgg = await db.rate.aggregate({
    where: { activity_id: params.activityId, is_active: true },
    _max: { duration_minutes: true },
  });
  const candidateDurationMs = (durAgg._max.duration_minutes ?? 240) * 60_000;
  const constraints = await getResourceConstraints(
    db,
    params.activityId,
    slots.map((s) => ({ id: s.id, datetime: s.datetime })),
    candidateDurationMs,
  );

  return {
    activityId: params.activityId,
    date: params.date,
    timezone: timeZone,
    timeslots: slots.map((s) => toView(s, constraints.get(s.id)?.remaining ?? null)),
  };
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

  const slots = await db.timeslot.findMany({
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
  });

  // Seed every calendar day in the range so days with no slots still appear (red).
  const buckets = new Map<
    string,
    { slotCount: number; capacityTotal: number; capacityBooked: number }
  >();
  for (
    let cursor = new Date(rangeStart.getTime());
    cursor.getTime() < rangeEnd.getTime();

  ) {
    const key = dayKey(timeZone, cursor);
    if (!buckets.has(key)) {
      buckets.set(key, { slotCount: 0, capacityTotal: 0, capacityBooked: 0 });
    }
    // Advance ~1 day; dayKey collapses any DST drift to the right calendar date.
    cursor = new Date(cursor.getTime() + 86_400_000);
  }

  for (const slot of slots) {
    const key = dayKey(timeZone, slot.datetime);
    const bucket = buckets.get(key) ?? { slotCount: 0, capacityTotal: 0, capacityBooked: 0 };
    bucket.slotCount += 1;
    bucket.capacityTotal += slot.capacity_total;
    bucket.capacityBooked += slot.capacity_booked;
    buckets.set(key, bucket);
  }

  const days: DayAvailability[] = [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, b]) => {
      const remaining = Math.max(0, b.capacityTotal - b.capacityBooked);
      // A day is red when nothing can be booked. Otherwise reuse the slot-status rule
      // on the day's aggregate capacity: FULL/-ish -> red, FILLING_UP -> yellow, else green.
      let signal: DayAvailability['signal'];
      if (b.slotCount === 0 || remaining <= 0) {
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
