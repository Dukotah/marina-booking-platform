/**
 * Cart-hold service — the short-lived seat reservation that makes a checkout
 * honest about the last seat.
 *
 * The problem: between "guest taps Book" and "guest taps Pay" the seat is not yet
 * consumed (no Order exists), so two guests can both open checkout for the last
 * seat, both pay, and one gets refused — or worse, the slot oversells. A CartHold
 * closes that window: starting checkout reserves `seats` for Operator
 * .cart_hold_minutes, and availability SUBTRACTS every un-expired, un-consumed
 * hold just like booked capacity. The hold is:
 *
 *   - created race-safely — the SAME `SELECT ... FOR UPDATE` row lock the booking
 *     service takes on the timeslot serialises two racing holds, so only one can
 *     win the last seat (the loser reads the first's committed hold and fails);
 *   - freed on expiry — lazily (every read filters `expires_at > now` and
 *     `consumed_at IS NULL`, so an expired hold stops counting the instant it
 *     lapses, with no sweep required) and swept (POST /internal/holds/sweep
 *     deletes the dead rows so the table doesn't grow unbounded);
 *   - consumed by the booking that owns it — {@link consumeHold} marks it
 *     consumed inside the booking transaction so its seats aren't double-counted
 *     against the capacity the same booking just incremented.
 *
 * Seats are an integer count; the server is the authority on how many seats are
 * free (it re-reads capacity + live holds under the lock and never trusts the
 * client's view of availability).
 */
import { adminPrisma, withTenant } from '@marina/database';
import type { Prisma, TenantClient } from '@marina/database';
import { captureError } from './errors.js';

/** A typed, user-facing failure the route maps to a clean HTTP status. */
export class HoldError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'HoldError';
    this.code = code;
    this.status = status;
  }
}

/** Hold durations are clamped to a sane band so a misconfig can't wedge a slot. */
const MIN_HOLD_MINUTES = 1;
const MAX_HOLD_MINUTES = 120;
const DEFAULT_HOLD_MINUTES = 10;

export interface CreateHoldInput {
  timeslotId: string;
  seats: number;
}

export interface CreateHoldResult {
  holdId: string;
  /** UTC instant the hold lapses, ISO-8601 — the countdown's deadline. */
  expiresAt: string;
  /** Minutes the hold was granted for (the operator's configured window). */
  holdMinutes: number;
  /** Seats reserved by this hold. */
  seats: number;
}

/**
 * Seats currently held (un-expired AND un-consumed) against a timeslot, summed in
 * SQL. This is the number availability subtracts on top of `capacity_booked`.
 * `at` is the reference instant so a single availability request measures every
 * slot against one clock. Exported so the availability service can fold it into
 * each slot's effective booked count.
 */
export async function heldSeatsByTimeslot(
  db: TenantClient,
  timeslotIds: string[],
  at: Date = new Date(),
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (timeslotIds.length === 0) return result;

  const rows = await db.cartHold.groupBy({
    by: ['timeslot_id'],
    where: {
      timeslot_id: { in: timeslotIds },
      consumed_at: null,
      expires_at: { gt: at },
    },
    _sum: { seats: true },
  });
  for (const r of rows) result.set(r.timeslot_id, r._sum.seats ?? 0);
  return result;
}

/**
 * Reserve `seats` on a timeslot for the operator's cart-hold window.
 *
 * Race-safety mirrors the booking service exactly: lock the timeslot row FOR
 * UPDATE, then read `capacity_booked` plus the live (un-expired, un-consumed) held
 * seats under that lock. Two concurrent holds for the last seat serialise on the
 * lock — the second blocks until the first COMMITS, then sees the first's hold and
 * correctly fails. The lock is released at end-of-tx. We lock ONLY this slot, so
 * holds on unrelated slots never contend.
 */
export async function createHold(
  operatorId: string,
  input: CreateHoldInput,
): Promise<CreateHoldResult> {
  const seats = Math.trunc(input.seats);
  if (!Number.isFinite(seats) || seats <= 0) {
    throw new HoldError('INVALID_SEATS', 'seats must be a positive integer');
  }

  return withTenant(operatorId, async (tx) => {
    // Hold window is the server's authority, not the client's — clamped to a band.
    const operator = await tx.operator.findFirst({
      where: { id: operatorId },
      select: { is_active: true, cart_hold_minutes: true },
    });
    if (!operator) {
      throw new HoldError('OPERATOR_NOT_FOUND', 'Operator not found', 404);
    }
    if (!operator.is_active) {
      throw new HoldError('OPERATOR_INACTIVE', 'This operator is not accepting bookings', 403);
    }
    const holdMinutes = Math.min(
      MAX_HOLD_MINUTES,
      Math.max(MIN_HOLD_MINUTES, operator.cart_hold_minutes ?? DEFAULT_HOLD_MINUTES),
    );

    // Lock the slot row — the same guard createBookingAttempt uses. Everything that
    // reads capacity for a write (book OR hold) must serialise through this lock, or
    // a hold and a booking racing for the last seat could both see room.
    const locked = await tx.$queryRaw<
      Array<{ id: string; datetime: Date; capacity_total: number; capacity_booked: number; status: string }>
    >`
      SELECT id, datetime, capacity_total, capacity_booked, status
      FROM "Timeslot"
      WHERE id = ${input.timeslotId}
      FOR UPDATE`;
    const slot = locked[0];
    if (!slot) {
      throw new HoldError('TIMESLOT_NOT_FOUND', 'Timeslot not found', 404);
    }
    if (slot.status === 'CANCELLED') {
      throw new HoldError('TIMESLOT_CANCELLED', 'This timeslot has been cancelled', 409);
    }
    if (slot.datetime.getTime() <= Date.now()) {
      throw new HoldError('TIMESLOT_PAST', 'This timeslot can no longer be held', 409);
    }

    // Live held seats under the lock — un-expired, un-consumed holds only. A lapsed
    // hold is dead weight that must not reduce what this guest can reserve.
    const now = new Date();
    const heldAgg = await tx.cartHold.aggregate({
      where: {
        timeslot_id: input.timeslotId,
        consumed_at: null,
        expires_at: { gt: now },
      },
      _sum: { seats: true },
    });
    const held = heldAgg._sum.seats ?? 0;

    const available = slot.capacity_total - slot.capacity_booked - held;
    if (seats > available) {
      throw new HoldError(
        'INSUFFICIENT_CAPACITY',
        available <= 0
          ? 'This timeslot is fully reserved right now'
          : `Only ${available} spot(s) can be held for this timeslot`,
        409,
      );
    }

    const expiresAt = new Date(now.getTime() + holdMinutes * 60_000);
    const hold = await tx.cartHold.create({
      data: {
        operator_id: operatorId,
        timeslot_id: input.timeslotId,
        seats,
        expires_at: expiresAt,
      },
      select: { id: true, expires_at: true, seats: true },
    });

    return {
      holdId: hold.id,
      expiresAt: hold.expires_at.toISOString(),
      holdMinutes,
      seats: hold.seats,
    };
  });
}

/**
 * Consume the hold that backed a booking, INSIDE that booking's transaction. The
 * seats it reserved are now counted as real booked capacity (the booking
 * incremented `capacity_booked`), so the hold must stop subtracting too — else the
 * slot would be double-debited. Idempotent (only flips an un-consumed, matching
 * hold) and tenant-scoped to the booking's own transaction client.
 *
 * A missing/mismatched/already-consumed hold is a no-op: a booking without a hold
 * (staff/POS, or a hold that expired mid-checkout) still succeeds — the booking's
 * own FOR UPDATE capacity check is the authority, the hold is only an optimisation
 * on top of it.
 */
export async function consumeHold(
  tx: Prisma.TransactionClient,
  params: { holdId: string; timeslotId: string },
): Promise<void> {
  await tx.cartHold.updateMany({
    where: { id: params.holdId, timeslot_id: params.timeslotId, consumed_at: null },
    data: { consumed_at: new Date() },
  });
}

/** Release a still-active hold early (guest abandoned checkout / changed seats). */
export async function releaseHold(operatorId: string, holdId: string): Promise<void> {
  await withTenant(operatorId, (tx) =>
    tx.cartHold.deleteMany({ where: { id: holdId, consumed_at: null } }),
  );
}

export interface SweepResult {
  operators: number;
  deleted: number;
}

/**
 * Delete expired / consumed holds across every active operator. Lazy on-read
 * expiry already stops a lapsed hold from counting the instant it lapses; this
 * sweep is pure housekeeping so the table doesn't grow without bound. A consumed
 * hold is also swept — its booking owns the seats now, so the row is spent.
 *
 * Runs with NO tenant context (cross-tenant), so it uses a narrow, explicit WHERE
 * (operator_id + the expiry predicate) rather than a blanket deleteMany — the DB
 * SAFETY rule. Failures are isolated per operator so one bad tenant can't stall the
 * rest of the sweep.
 */
export async function runHoldsSweep(opts?: { now?: Date }): Promise<SweepResult> {
  const now = opts?.now ?? new Date();
  // Only operators that actually have a reap-able hold — keeps the sweep's work
  // proportional to the dead rows, not the tenant count.
  const targets = await adminPrisma.cartHold.groupBy({
    by: ['operator_id'],
    where: { OR: [{ expires_at: { lte: now } }, { consumed_at: { not: null } }] },
  });

  let deleted = 0;
  for (const t of targets) {
    try {
      const res = await withTenant(t.operator_id, (tx) =>
        tx.cartHold.deleteMany({
          where: {
            operator_id: t.operator_id,
            OR: [{ expires_at: { lte: now } }, { consumed_at: { not: null } }],
          },
        }),
      );
      deleted += res.count;
    } catch (err) {
      await captureError(err, { operatorId: t.operator_id, route: 'holds.runHoldsSweep' });
    }
  }

  return { operators: targets.length, deleted };
}
