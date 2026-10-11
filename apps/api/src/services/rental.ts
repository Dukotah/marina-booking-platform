/**
 * Open-duration RENTAL booking engine — the consumer the rental-window columns
 * never had.
 *
 * A rental Activity is a single boat let out by the hour: its active ScheduleRules
 * are RENTAL-WINDOW rules (open_minute/close_minute set, start_minutes empty),
 * which say "this boat is rentable on <weekdays> from open to close during the
 * <season>". There are no fixed departure Timeslots for it — the guest picks any
 * start, and the rate's duration_minutes gives the end.
 *
 * This service turns those windows into:
 *   1) AVAILABILITY — the bookable start times (or free gaps) on a given date for a
 *      rate's duration, = the union of matching rental windows for that weekday/
 *      season, MINUS whole-day BlackoutDate closures, MINUS the spans already taken
 *      by existing bookings on that boat.
 *   2) A BOOKING PATH — accept {activityId, date, startMinute, rateId, quantity,
 *      customer} and slot it into the EXISTING order/booking model by creating (or
 *      reusing) a Timeslot at that exact datetime and then delegating to the
 *      ordinary booking service. That reuse is deliberate and load-bearing: the
 *      FOR UPDATE timeslot lock, the per-pool advisory lock, the ResourceBooking
 *      half-open overlap guarantee, server-authoritative pricing, deposits, promos
 *      and idempotency are ALL inherited unchanged — a rental is just a booking
 *      whose timeslot the engine materializes on demand instead of a rule.
 *
 * MONEY/CONCURRENCY DISCIPLINE: this file adds NO new money or locking path. Every
 * amount still flows through calculatePricing in the booking service (quote ==
 * charge, integer cents); every race is still decided by the same two locks the
 * booking service already holds. The rental-specific checks here (inside an open
 * window, not during a blackout, fits a free gap) are guards layered BEFORE that
 * engine runs; the final authority on "is the boat free over [start,end)" is the
 * ResourceBooking overlap check under the lock, so a race that slips past the
 * availability read is still refused with a clean 409.
 *
 * Fixed-departure tour boats (rules WITH start_minutes) are never touched: they
 * have no rental-window rules, so isRentalActivity is false and every path here
 * refuses them, leaving their discrete-Timeslot flow exactly as it was.
 */
import {
  bookableStartMinutes,
  fitsInFreeRange,
  freeRangesForDay,
  rentableRangesForDay,
  type MinuteRange,
  type RentalWindowRule,
} from '@marina/core';
import {
  Prisma,
  blackoutDaysForActivity,
  localTimeToUtc,
  withTenant,
  type TenantClient,
} from '@marina/database';
import {
  BookingError,
  createBookingIdempotent,
  type BookingOrder,
  type CreateBookingOptions,
} from './booking.js';
import { activityResourcePools } from './resources.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MINUTES_PER_DAY = 24 * 60;

/** A typed failure the rental routes map to a clean HTTP status (mirrors BookingError). */
export class RentalError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'RentalError';
    this.code = code;
    this.status = status;
  }
}

/** The rental-window rule rows this service reads, in the shape the core math wants. */
interface RentalRuleRow {
  start_date: string;
  end_date: string;
  weekdays: number[];
  open_minute: number | null;
  close_minute: number | null;
  start_minutes: number[];
  is_active: boolean;
}

/** True when a stored rule is a rental-window rule (open/close set, no fixed departures). */
function isRentalRule(r: RentalRuleRow): boolean {
  return r.open_minute !== null && r.close_minute !== null && r.start_minutes.length === 0;
}

/** Project a rental rule row onto the core RentalWindowRule contract. */
function toWindowRule(r: RentalRuleRow): RentalWindowRule {
  return {
    startDate: r.start_date,
    endDate: r.end_date,
    weekdays: r.weekdays,
    openMinute: r.open_minute,
    closeMinute: r.close_minute,
    isActive: r.is_active,
  };
}

/**
 * Is this activity an OPEN-DURATION RENTAL — i.e. does it have at least one ACTIVE
 * rental-window rule? Fixed-departure activities (rules with start_minutes) and
 * activities with no rules at all return false, so callers keep the discrete-slot
 * path untouched for them.
 */
export async function isRentalActivity(
  db: TenantClient,
  activityId: string,
): Promise<boolean> {
  const rules = await db.scheduleRule.findMany({
    where: { activity_id: activityId, is_active: true },
    select: { open_minute: true, close_minute: true, start_minutes: true },
  });
  return rules.some(
    (r) => r.open_minute !== null && r.close_minute !== null && r.start_minutes.length === 0,
  );
}

/** Resolve the timezone the activity operates in (location override -> operator). */
async function resolveTimezone(db: TenantClient, activityId: string): Promise<string> {
  const activity = await db.activity.findUnique({
    where: { id: activityId },
    select: {
      operator: { select: { timezone: true } },
      location: { select: { timezone: true } },
    },
  });
  if (!activity) throw new RentalError('ACTIVITY_NOT_FOUND', 'Activity not found', 404);
  return activity.location?.timezone ?? activity.operator.timezone;
}

function parseDate(value: string): void {
  if (!DATE_RE.test(value)) {
    throw new RentalError('INVALID_DATE', 'date must be a YYYY-MM-DD date');
  }
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new RentalError('INVALID_DATE', 'date is not a valid calendar date');
  }
}

/**
 * The spans already taken on this boat on `isoDate`, as operator-local
 * minute-ranges. Read from the ResourceBooking rows on the activity's resource
 * pools — the SAME rows the booking engine's overlap check consults — so the free
 * gaps here reflect exactly what the engine would refuse.
 *
 * A booking's UTC window is projected onto the local day by clamping to the day's
 * [0, 1440) minute span: a rental that runs past midnight (or started the previous
 * evening) still correctly blocks the portion that lands on this day. Pools are
 * unioned because any one of them being busy blocks the boat.
 *
 * When the activity has no linked resource pool at all, there is nothing to read —
 * such an activity isn't a real shared-asset rental and we treat the whole window
 * as free (the booking engine's timeslot capacity is then the only limiter).
 */
async function takenSpansForDay(
  db: TenantClient,
  activityId: string,
  isoDate: string,
  timeZone: string,
): Promise<MinuteRange[]> {
  const rdb = db as unknown as Prisma.TransactionClient;
  const pools = await activityResourcePools(rdb, activityId);
  if (pools.length === 0) return [];

  // The UTC instants bounding this local calendar day.
  const dayStartUtc = localTimeToUtc(isoDate, 0, timeZone);
  const dayEndUtc = new Date(dayStartUtc.getTime() + MINUTES_PER_DAY * 60_000);

  const rows = await rdb.resourceBooking.findMany({
    where: {
      resource_id: { in: pools.map((p) => p.id) },
      // Any reservation overlapping [dayStart, dayEnd) touches this day.
      starts_at: { lt: dayEndUtc },
      ends_at: { gt: dayStartUtc },
    },
    select: { starts_at: true, ends_at: true },
  });

  const spans: MinuteRange[] = [];
  for (const r of rows) {
    // Minutes since this local day's midnight, clamped to [0, 1440].
    const openMin = Math.max(0, Math.round((r.starts_at.getTime() - dayStartUtc.getTime()) / 60_000));
    const closeMin = Math.min(
      MINUTES_PER_DAY,
      Math.round((r.ends_at.getTime() - dayStartUtc.getTime()) / 60_000),
    );
    if (closeMin > openMin) spans.push({ open: openMin, close: closeMin });
  }
  return spans;
}

/** One bookable rental option for a specific rate. */
export interface RentalRateAvailability {
  rateId: string;
  rateName: string;
  priceCents: number;
  durationMinutes: number;
  /** Minutes-since-midnight a rental of this duration can start (ascending). */
  startMinutes: number[];
}

export interface RentalAvailability {
  activityId: string;
  date: string;
  timezone: string;
  /** True when the day is wholly closed (blackout) — windows/gaps are then empty. */
  closed: boolean;
  /** The day's rentable windows (season/weekday match), before taken spans. */
  windows: MinuteRange[];
  /** Rentable windows MINUS taken spans — the stretches still free to book. */
  freeGaps: MinuteRange[];
  /** Per-rate bookable start times. When `rateId` was given, just that rate. */
  rates: RentalRateAvailability[];
}

/**
 * Availability for an open-duration rental on one calendar day.
 *
 * windows   = union of matching rental-window rules for that weekday/season
 * freeGaps  = windows minus whole-day blackout minus spans already taken on the boat
 * rates[].startMinutes = for each rate's duration, the starts that fit in a free gap
 *
 * Pass `rateId` to restrict to a single rate (the booking flow's case); omit it to
 * get every active public rate (a picker's case). Throws RentalError('NOT_RENTAL')
 * for a fixed-departure activity so callers fall back to the timeslot path.
 */
export async function getRentalAvailability(
  db: TenantClient,
  params: { activityId: string; date: string; rateId?: string; stepMinutes?: number },
): Promise<RentalAvailability> {
  parseDate(params.date);
  const timeZone = await resolveTimezone(db, params.activityId);

  const ruleRows = await db.scheduleRule.findMany({
    where: { activity_id: params.activityId },
    select: {
      start_date: true,
      end_date: true,
      weekdays: true,
      open_minute: true,
      close_minute: true,
      start_minutes: true,
      is_active: true,
    },
  });
  const rentalRules = ruleRows.filter(isRentalRule);
  if (rentalRules.filter((r) => r.is_active).length === 0) {
    throw new RentalError(
      'NOT_RENTAL',
      'This activity is not an open-duration rental',
      409,
    );
  }

  const windows = rentableRangesForDay(rentalRules.map(toWindowRule), params.date);

  // Whole-day blackout closes everything for that date.
  const activity = await db.activity.findUnique({
    where: { id: params.activityId },
    select: { location_id: true },
  });
  const blackout = await blackoutDaysForActivity(
    db as unknown as Prisma.TransactionClient,
    { id: params.activityId, location_id: activity?.location_id ?? null },
    params.date,
    params.date,
  );
  const closed = blackout.has(params.date);

  const taken = closed ? [] : await takenSpansForDay(db, params.activityId, params.date, timeZone);
  const freeGaps = closed ? [] : freeRangesForDay(windows, taken);

  // Rates to size the start grid against.
  const rateRows = await db.rate.findMany({
    where: {
      activity_id: params.activityId,
      is_active: true,
      internal_only: false,
      ...(params.rateId ? { id: params.rateId } : {}),
    },
    orderBy: { sort_index: 'asc' },
    select: {
      id: true,
      name_external: true,
      price_cents: true,
      duration_minutes: true,
    },
  });
  if (params.rateId && rateRows.length === 0) {
    throw new RentalError('RATE_NOT_FOUND', 'Rate not found for this activity', 404);
  }

  const rates: RentalRateAvailability[] = rateRows.map((r) => ({
    rateId: r.id,
    rateName: r.name_external,
    priceCents: r.price_cents,
    durationMinutes: r.duration_minutes,
    startMinutes: closed
      ? []
      : bookableStartMinutes(freeGaps, r.duration_minutes, params.stepMinutes),
  }));

  return {
    activityId: params.activityId,
    date: params.date,
    timezone: timeZone,
    closed,
    windows,
    freeGaps,
    rates,
  };
}

/** Input for {@link createRentalBooking} — a booking at a chosen start+duration. */
export interface RentalBookingInput {
  activityId: string;
  /** Local calendar day the rental is on, YYYY-MM-DD. */
  date: string;
  /** Start, minutes since operator-local midnight (the rate's duration gives the end). */
  startMinute: number;
  rateId: string;
  quantity: number;
  customer: {
    first_name: string;
    last_name: string;
    email: string;
    phone?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
  };
  /** Optional: promo code, tip, participants — passed straight through to the engine. */
  promoCode?: string;
  tipCents?: number;
}

/**
 * Book an open-duration rental.
 *
 * Validation (all BEFORE the money engine runs, so a rejected rental changes
 * nothing): the activity is a rental, the rate belongs to it, and
 * [startMinute, startMinute+duration) fits inside a FREE gap for that date — which
 * is simultaneously "inside an open window", "not during a blackout" and "not
 * already taken on this boat". Then it materializes a Timeslot at the exact UTC
 * start and hands off to {@link createBookingIdempotent}, inheriting that path's
 * FOR UPDATE + per-pool lock, ResourceBooking overlap guarantee, pricing, and
 * idempotency. The final free-over-[start,end) authority is that overlap check
 * under the lock: two racing rentals for the same boat/window both reach it, and
 * exactly one wins (the loser gets INSUFFICIENT_RESOURCE), so the availability
 * read here is an optimisation, never the guard.
 *
 * Idempotent via options.idempotencyKey (same semantics as the booking service):
 * a replay resolves to the order that already exists and materializes no second
 * timeslot. The timeslot is minute-unique per activity, so two rentals at the same
 * start reuse one slot row and race on its FOR UPDATE lock + the pool overlap.
 */
export async function createRentalBooking(
  operatorId: string,
  input: RentalBookingInput,
  options: CreateBookingOptions = {},
): Promise<BookingOrder> {
  if (!Number.isInteger(input.startMinute) || input.startMinute < 0 || input.startMinute >= MINUTES_PER_DAY) {
    throw new RentalError('INVALID_START', 'startMinute must be a minute of the day (0..1439)');
  }
  parseDate(input.date);

  // Resolve the timezone + rate duration, and validate the rental fits a free gap.
  // This read is outside the booking transaction (it only informs the guard); the
  // authoritative free-over-window check is the ResourceBooking overlap under the
  // lock inside createBookingIdempotent.
  const timeslotId = await withTenant(operatorId, async (tx) => {
    const db = tx as unknown as TenantClient;

    const rate = await tx.rate.findFirst({
      where: { id: input.rateId, activity_id: input.activityId },
      select: { duration_minutes: true, is_active: true, internal_only: true },
    });
    if (!rate) throw new RentalError('RATE_NOT_FOUND', 'Rate not found for this activity', 404);
    if (!rate.is_active) throw new RentalError('RATE_UNAVAILABLE', 'This rate is no longer available', 409);

    // Availability reflects taken spans too, so this rejects an already-taken window
    // early with a clear message (the lock below is the race-proof backstop).
    const availability = await getRentalAvailability(db, {
      activityId: input.activityId,
      date: input.date,
      rateId: input.rateId,
    });
    if (availability.closed) {
      throw new RentalError('BLACKOUT', 'The marina is closed on that date', 409);
    }
    if (!fitsInFreeRange(availability.freeGaps, input.startMinute, rate.duration_minutes)) {
      // Distinguish "outside the open window" from "already taken" for the message.
      const insideWindow = availability.windows.some(
        (w) => input.startMinute >= w.open && input.startMinute + rate.duration_minutes <= w.close,
      );
      throw new RentalError(
        insideWindow ? 'SLOT_TAKEN' : 'OUTSIDE_WINDOW',
        insideWindow
          ? 'That time is already booked on this boat'
          : 'That start time and duration fall outside the rentable window',
        409,
      );
    }

    // Materialize (or reuse) the Timeslot at the exact UTC instant of the start. A
    // rental slot carries the whole-boat capacity so the ResourceBooking pool is the
    // real limiter (identical to how the resource-capacity suite seeds generous
    // timeslot capacity). schedule_rule_id stays null: this is an on-demand one-off,
    // NOT a rule-materialized departure, so the schedule materializer never touches it.
    const startUtc = localTimeToUtc(input.date, input.startMinute, availability.timezone);
    const activity = await tx.activity.findFirst({
      where: { id: input.activityId },
      select: { max_participants: true, status: true },
    });
    if (!activity) throw new RentalError('ACTIVITY_NOT_FOUND', 'Activity not found', 404);

    // Reuse an existing one-off slot at this exact instant if a prior rental made one
    // (so two rentals at the same start share a slot and race on its lock); otherwise
    // create it. If the booking hand-off below then fails (e.g. the race loser, or a
    // pricing guard), this empty slot (capacity_booked = 0) is simply left behind — it
    // is harmless: a retry reuses it, it holds no booking, and the schedule
    // materializer never touches a schedule_rule_id = null slot.
    const existing = await tx.timeslot.findFirst({
      where: { activity_id: input.activityId, datetime: startUtc },
      select: { id: true },
    });
    if (existing) return existing.id;

    const created = await tx.timeslot.create({
      data: {
        operator_id: operatorId,
        activity_id: input.activityId,
        datetime: startUtc,
        capacity_total: Math.max(activity.max_participants, input.quantity),
        capacity_booked: 0,
        status: 'AVAILABLE',
        schedule_rule_id: null,
      },
      select: { id: true },
    });
    return created.id;
  });

  // Hand off to the ordinary booking engine: FOR UPDATE slot lock + per-pool lock +
  // ResourceBooking half-open overlap + server-authoritative pricing + idempotency,
  // all inherited unchanged. A rental is just a booking on a materialized slot.
  //
  // The engine's CustomerInput treats absent optional fields as `undefined`; our
  // input allows `null` too (route payloads), so coalesce null -> undefined here.
  const customer = {
    first_name: input.customer.first_name,
    last_name: input.customer.last_name,
    email: input.customer.email,
    ...(input.customer.phone ? { phone: input.customer.phone } : {}),
    ...(input.customer.address ? { address: input.customer.address } : {}),
    ...(input.customer.city ? { city: input.customer.city } : {}),
    ...(input.customer.state ? { state: input.customer.state } : {}),
    ...(input.customer.zip ? { zip: input.customer.zip } : {}),
  };
  return createBookingIdempotent(
    operatorId,
    {
      activityId: input.activityId,
      rateId: input.rateId,
      timeslotId,
      quantity: input.quantity,
      customer,
      participants: [],
      ...(input.promoCode ? { promoCode: input.promoCode } : {}),
      ...(input.tipCents != null ? { tipCents: input.tipCents } : {}),
    },
    // Rentals today come from staff/POS; default the channel to STAFF so an
    // already-started same-day walk-up is allowed (CUSTOMER would be refused by the
    // engine's "slot already started" guard). The route can override.
    { channel: 'STAFF', ...options },
  ).then((r) => r.order);
}
