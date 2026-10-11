/**
 * Booking service — the server-authoritative path that turns a validated booking
 * request into a persisted Order. This is the heart of the money flow, so it:
 *
 *   - runs inside a single tenant-scoped transaction (`withTenant`) so RLS scopes
 *     every write and the whole operation is atomic;
 *   - NEVER trusts client-supplied prices — it re-reads the Rate and the Activity's
 *     Fees from the database and recomputes the full breakdown with
 *     `@marina/core` `calculatePricing`;
 *   - validates real-time timeslot capacity before committing and increments
 *     `capacity_booked` (recomputing the slot's display status);
 *   - upserts the Customer by (operator, email) and records an OrderEvent audit row.
 */
import { Prisma } from '@marina/database';
import {
  applyMemberPrice,
  calculatePricing,
  computeDepositCents,
  computeSlotStatus,
  computeCancellationRefund,
  generateOrderNumber,
  priceRateClasses,
  resolveDepositPercent,
  type BookingInput,
  type CancellationPolicy,
  type PricingFee,
  type PricingPromo,
  type RateClassLine,
} from '@marina/core';
import { withTenant } from '@marina/database';
import { getPaymentProvider, settledOrThrow } from './payments/index.js';
import { reconcileSlotPrice } from './pricing-rules.js';
import {
  activityResourcePools,
  bookingWindow,
  findResourceConflict,
  lockResourcePools,
  releaseResourceBookings,
  writeResourceBookings,
} from './resources.js';
import { bestActiveMemberPricing, consumeMembershipUses } from './memberships.js';
import { queueWaitlistNotifications } from './waitlist.js';
import { consumeHold } from './holds.js';
import { sendBookingCancellation } from './notifications.js';
import { sendBookingCancellationSms } from './sms.js';
import {
  addOnPricingItems,
  buildAddOnOrderItems,
  reserveAddOnStock,
  resolveAddOnLines,
  type PricedAddOnLine,
} from './addons.js';

/**
 * Tell the guest their booking was cancelled, on both channels. FIRE-AND-FORGET:
 * called only AFTER the cancel transaction commits, runs off the response path,
 * and never throws — the exact contract dispatchBookingNotifications has on the
 * create path, so a slow or failing provider can never block or fail a cancel.
 *
 * Sequential (not concurrent) for the same reason the create-path dispatcher is:
 * each send opens its own tenant-scoped transaction that sets the operator id with
 * SET LOCAL on a shared Prisma client, and firing them together interleaves those
 * transactions and corrupts the connection's protocol state.
 */
function dispatchCancellationNotifications(operatorId: string, orderId: string): void {
  void (async () => {
    await sendBookingCancellation({ operatorId, orderId });
    await sendBookingCancellationSms({ operatorId, orderId });
  })();
}

/** How an order entered the system (mirrors Prisma `OrderChannel`). */
export type BookingChannel = 'CUSTOMER' | 'STAFF' | 'KIOSK';

export interface CreateBookingOptions {
  /** Channel the booking came through. Defaults to CUSTOMER (public web). */
  channel?: BookingChannel;
  /** Audit actor for the OrderEvent (e.g. a staff member's id/email). */
  actor?: string;
  /**
   * Client-supplied de-duplication key for this checkout attempt. When present it
   * is persisted on the Order and the unique index `(operator_id, idempotency_key)`
   * makes a replayed submit resolve to the order that already exists instead of
   * building a second one. Omit (or pass null) for non-retryable staff/POS paths.
   */
  idempotencyKey?: string | null;
  /**
   * The CartHold this checkout reserved its seats under, if any. Consumed inside
   * the booking transaction once capacity is incremented, so its seats stop
   * double-subtracting from availability. A missing/expired/mismatched hold is a
   * no-op — the booking's own FOR UPDATE capacity check is always the authority.
   */
  holdId?: string | null;
}

/** A typed, user-facing failure that route handlers map to a clean HTTP status. */
export class BookingError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
    this.status = status;
  }
}

// --- Idempotent create: the replay decision -------------------------------
//
// A double-submit (impatient tap, retried request on flaky rural service) must
// never produce two orders or two charges. The durable guard is the unique index
// `Order(operator_id, idempotency_key)`: BOTH submits try to insert, one loses the
// race, and the loser's WHOLE transaction rolls back — so it consumes no capacity,
// writes no Payment, and never reaches the notification dispatch. The loser then
// reads back the winner's order and returns it as the answer.
//
// This is deliberately NOT a check-then-insert. A pre-read exists below purely as
// an optimisation for the *sequential* replay (see `createBookingIdempotent`), but
// it is never the guard: two concurrent submits can both pass any pre-read, and the
// index is what makes that harmless.

/** Longest key we will persist. Long enough for a UUID/ULID plus a prefix. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Normalize a client-supplied idempotency key.
 *
 * Blank/absent becomes `null` rather than `''`, because an empty string is a real
 * value to the unique index — every keyless order would then collide with every
 * other one. Over-length keys are rejected instead of truncated: truncation would
 * silently merge two distinct submits into one order.
 */
export function normalizeIdempotencyKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new BookingError(
      'INVALID_IDEMPOTENCY_KEY',
      `Idempotency key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  return trimmed;
}

/**
 * True when `err` is Prisma's unique-constraint violation (P2002).
 *
 * Duck-typed on the code rather than `instanceof PrismaClientKnownRequestError`:
 * the error crosses a package boundary (`@marina/database` -> here), and an
 * `instanceof` against a second copy of the generated client silently returns
 * false — which would turn a recoverable replay into a 500.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/**
 * The columns/constraint a P2002 names, normalized to a string array. Prisma
 * reports `meta.target` as a field-name array on Postgres but as the raw
 * constraint name on some drivers/versions, and omits it entirely for a few
 * error paths — so all three shapes are handled.
 */
export function uniqueViolationTargets(err: unknown): string[] {
  if (!isUniqueViolation(err)) return [];
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  if (typeof target === 'string') return [target];
  if (Array.isArray(target)) return target.filter((t): t is string => typeof t === 'string');
  return [];
}

/** True when a P2002's target is (or includes) the idempotency-key index. */
export function isIdempotencyViolation(err: unknown): boolean {
  return uniqueViolationTargets(err).some((t) => t.includes('idempotency_key'));
}

/**
 * Whether a failed create should be resolved by reading back an existing order.
 *
 * Any unique violation on a keyed create is worth a lookup: `meta.target` is not
 * always populated, and even a collision reported against another index (e.g. the
 * per-day `order_number` sequence, which two simultaneous submits can compute
 * identically) means a concurrent writer got there first. The lookup itself is the
 * decider — it returns the order or it doesn't — so a needless one is only a wasted
 * read, whereas a skipped one is a spurious 500 on a retry.
 */
export function shouldResolveAsReplay(err: unknown, idempotencyKey: string | null): boolean {
  return idempotencyKey !== null && isUniqueViolation(err);
}

/** The relations every booking response needs; shared by create and replay reads. */
const BOOKING_ORDER_INCLUDE = {
  items: { include: { activity: true, rate: true, timeslot: true } },
  customer: true,
} satisfies Prisma.OrderInclude;

/** A persisted Order hydrated with everything the API response serializes. */
export type BookingOrder = Prisma.OrderGetPayload<{ include: typeof BOOKING_ORDER_INCLUDE }>;

/** Outcome of an idempotent create. */
export interface CreateBookingResult {
  /** The order this submit resolves to — freshly created, or the replayed original. */
  order: BookingOrder;
  /**
   * True when this call did NOT create anything: an order with the same key already
   * existed. Callers must skip every side effect they own for a replay — notably
   * confirmation email/SMS, which the customer already received.
   */
  replayed: boolean;
}

/** Read back the order a key already resolved to, or null if there isn't one. */
async function findOrderByIdempotencyKey(
  operatorId: string,
  idempotencyKey: string,
): Promise<BookingOrder | null> {
  return withTenant(operatorId, (tx) =>
    tx.order.findFirst({
      where: { idempotency_key: idempotencyKey },
      include: BOOKING_ORDER_INCLUDE,
    }),
  );
}

/**
 * Create a booking, resolving a replayed submit to the order that already exists.
 *
 * Two submits carrying one key produce exactly one order, one capacity draw, one
 * Payment, and one notification — whether they arrive concurrently (the loser hits
 * the unique index and rolls back) or sequentially (the pre-read short-circuits
 * before any work is done). Without a key this is a plain create.
 */
export async function createBookingIdempotent(
  operatorId: string,
  input: BookingInput,
  options: CreateBookingOptions = {},
): Promise<CreateBookingResult> {
  const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);

  // Fast path for a sequential replay. This is an optimisation, not the guard —
  // but it is also a correctness fix for the retry that arrives after the first
  // one committed: re-running the full create would fail the capacity/promo checks
  // against the state the FIRST submit produced (a slot the customer just filled
  // reads as INSUFFICIENT_CAPACITY), turning a duplicate into a bogus 409.
  if (idempotencyKey) {
    const existing = await findOrderByIdempotencyKey(operatorId, idempotencyKey);
    if (existing) return { order: existing, replayed: true };
  }

  try {
    const order = await createBookingAttempt(operatorId, input, options, idempotencyKey);
    return { order, replayed: false };
  } catch (err) {
    // `shouldResolveAsReplay` already demands a key; repeating the null check here
    // keeps the narrowing local so the lookup needs no assertion.
    if (idempotencyKey === null || !shouldResolveAsReplay(err, idempotencyKey)) throw err;

    // We lost the insert race. The winner has committed (Postgres blocks the
    // duplicate insert until it does), so its order is readable now — and our own
    // transaction rolled back whole, so no capacity, payment, or promo redemption
    // was consumed by this attempt.
    const winner = await findOrderByIdempotencyKey(operatorId, idempotencyKey);
    if (winner) return { order: winner, replayed: true };

    // The key's index rejected us but no order carries it: the winner was rolled
    // back or deleted after we blocked on it. That is retryable, so surface a 409
    // rather than letting a duplicate-key error escape as a 500.
    if (isIdempotencyViolation(err)) {
      throw new BookingError(
        'BOOKING_IN_FLIGHT',
        'An identical booking is already being processed. Please try again.',
        409,
      );
    }
    throw err;
  }
}

/**
 * Create a booking for the given operator. Returns the persisted Order with its
 * items, customer, and timeslot/activity context needed by the API response.
 *
 * Honours `options.idempotencyKey` — a replay resolves to the existing order. Use
 * {@link createBookingIdempotent} when the caller has side effects of its own to
 * suppress (notifications), since it reports whether the order was replayed.
 */
export async function createBooking(
  operatorId: string,
  input: BookingInput,
  options: CreateBookingOptions = {},
): Promise<BookingOrder> {
  const { order } = await createBookingIdempotent(operatorId, input, options);
  return order;
}

/**
 * One attempt at building the whole order in a single tenant transaction. Either
 * every write lands or none does — which is what makes losing the idempotency race
 * safe: the loser leaves nothing behind to clean up.
 */
async function createBookingAttempt(
  operatorId: string,
  input: BookingInput,
  options: CreateBookingOptions,
  idempotencyKey: string | null,
): Promise<BookingOrder> {
  const channel: BookingChannel = options.channel ?? 'CUSTOMER';

  return withTenant(operatorId, async (tx) => {
    // --- Load + validate the operator (needed for the human order number). ---
    const operator = await tx.operator.findFirst({
      where: { id: operatorId },
      select: { id: true, location_code: true, is_active: true, default_deposit_percent: true },
    });
    if (!operator) {
      throw new BookingError('OPERATOR_NOT_FOUND', 'Operator not found', 404);
    }
    if (!operator.is_active) {
      throw new BookingError('OPERATOR_INACTIVE', 'This operator is not accepting bookings', 403);
    }

    // --- Load the activity (server source of truth for fees + visibility). ---
    const activity = await tx.activity.findFirst({
      where: { id: input.activityId },
      select: {
        id: true,
        status: true,
        visible_online: true,
        min_participants: true,
        max_participants: true,
        deposit_percent: true,
        waiver_required: true,
      },
    });
    if (!activity) {
      throw new BookingError('ACTIVITY_NOT_FOUND', 'Activity not found', 404);
    }
    if (activity.status !== 'ACTIVE') {
      throw new BookingError('ACTIVITY_UNAVAILABLE', 'This activity is not available for booking', 409);
    }

    // --- Load the rate; it must belong to this activity and be sellable. ---
    const rate = await tx.rate.findFirst({
      where: { id: input.rateId, activity_id: activity.id },
      select: {
        id: true,
        price_cents: true,
        duration_minutes: true,
        is_active: true,
        internal_only: true,
      },
    });
    if (!rate) {
      throw new BookingError('RATE_NOT_FOUND', 'Rate not found for this activity', 404);
    }
    if (!rate.is_active) {
      throw new BookingError('RATE_UNAVAILABLE', 'This rate is no longer available', 409);
    }

    // --- Per-head rate classes: resolve the effective quantity from the request.
    //     When the request carries a rateClasses[] breakdown, the server re-reads
    //     this rate's ACTIVE class catalog, refuses any unknown/inactive class id
    //     (so a tampered id can't sneak through priced at the base), and the sum of
    //     the requested counts becomes the effective quantity. Without a breakdown
    //     the booking stays single-quantity on input.quantity (one default "Guest"
    //     class synthesized at pricing time). Prices are NOT computed here — only
    //     the ids are validated + the quantity derived; pricing happens server-side
    //     below off the class catalog, never the client. ---
    const requestedClasses = (input.rateClasses ?? []).filter((rc) => rc.count > 0);
    const useRateClasses = requestedClasses.length > 0;
    let classCatalog: Array<{ id: string; label: string; price_modifier_cents: number }> = [];
    if (useRateClasses) {
      classCatalog = await tx.rateClass.findMany({
        where: { rate_id: rate.id, is_active: true },
        select: { id: true, label: true, price_modifier_cents: true },
      });
      const known = new Set(classCatalog.map((c) => c.id));
      for (const rc of requestedClasses) {
        if (!known.has(rc.classId)) {
          throw new BookingError(
            'INVALID_RATE_CLASS',
            'One or more selected guest types is no longer available',
            409,
          );
        }
      }
    }
    // Effective quantity: sum of per-class counts when a breakdown was sent, else
    // the plain single-quantity field. This is the number used for capacity,
    // min/max, resources, and the audit trail from here on.
    const effectiveQuantity = useRateClasses
      ? requestedClasses.reduce((n, rc) => n + Math.trunc(rc.count), 0)
      : input.quantity;

    if (
      effectiveQuantity < activity.min_participants ||
      effectiveQuantity > activity.max_participants
    ) {
      throw new BookingError(
        'INVALID_QUANTITY',
        `Quantity must be between ${activity.min_participants} and ${activity.max_participants}`,
      );
    }
    // Customers may only book public rates; staff/kiosk may use internal-only rates.
    if (rate.internal_only && channel === 'CUSTOMER') {
      throw new BookingError('RATE_UNAVAILABLE', 'This rate is not available online', 409);
    }

    // --- Lock + load the timeslot capacity. ---
    //
    // Overbooking is a TOCTOU race: two concurrent submits for the last seat both
    // read capacity_booked, both see room, and both write old+qty — selling 2 seats
    // on a 1-capacity slot. READ COMMITTED does not protect against it because each
    // tx reads a consistent snapshot taken before the other committed.
    //
    // The fix is a row lock. `SELECT ... FOR UPDATE` on this timeslot serialises
    // every booking that touches it: the second submit blocks on the first's lock
    // until it COMMITS, then reads the freshly-incremented capacity_booked and
    // correctly fails the capacity check below. The lock is held to end-of-tx, so
    // the whole check-then-increment is atomic per slot. We deliberately lock ONLY
    // the timeslot row (not the read below via Prisma), so contention is scoped to
    // the exact slot being sold and unrelated bookings never wait on each other.
    const locked = await tx.$queryRaw<
      Array<{
        id: string;
        datetime: Date;
        capacity_total: number;
        capacity_booked: number;
        status: string;
      }>
    >`
      SELECT id, datetime, capacity_total, capacity_booked, status
      FROM "Timeslot"
      WHERE id = ${input.timeslotId} AND activity_id = ${activity.id}
      FOR UPDATE`;
    const timeslot = locked[0];
    if (!timeslot) {
      throw new BookingError('TIMESLOT_NOT_FOUND', 'Timeslot not found for this activity', 404);
    }
    if (timeslot.status === 'CANCELLED') {
      throw new BookingError('TIMESLOT_CANCELLED', 'This timeslot has been cancelled', 409);
    }
    // Customers may only book slots still in the future. Staff keep the flexibility
    // to record a day-of walk-up on a slot that has already started.
    if (channel === 'CUSTOMER' && timeslot.datetime.getTime() <= Date.now()) {
      throw new BookingError(
        'TIMESLOT_PAST',
        'This timeslot has already started and can no longer be booked online',
        409,
      );
    }
    const remaining = timeslot.capacity_total - timeslot.capacity_booked;
    if (effectiveQuantity > remaining) {
      throw new BookingError(
        'INSUFFICIENT_CAPACITY',
        remaining <= 0
          ? 'This timeslot is fully booked'
          : `Only ${remaining} spot(s) remain for this timeslot`,
        409,
      );
    }

    // --- Shared-resource capacity: the same boat/guide can't be double-booked
    //     across activities that share it. No-op for activities with no resources. ---
    const pools = await activityResourcePools(tx, activity.id);
    const { startsAt, endsAt } = bookingWindow(timeslot.datetime, rate.duration_minutes);
    if (pools.length > 0) {
      // Serialise per pool: the timeslot lock above only covers THIS slot, but a shared
      // pool spans slots/activities. Without this, two bookings on different slots both
      // read used=0 and both insert, overselling the boat. Lock before the aggregate read.
      await lockResourcePools(tx, pools.map((p) => p.id));
      const conflict = await findResourceConflict(tx, {
        pools,
        startsAt,
        endsAt,
        seats: effectiveQuantity,
      });
      if (conflict) {
        throw new BookingError(
          'INSUFFICIENT_RESOURCE',
          conflict.remaining <= 0
            ? `${conflict.name} is fully booked for this time`
            : `Only ${conflict.remaining} left of ${conflict.name} for this time`,
          409,
        );
      }
    }

    // --- Recompute pricing server-side from DB fees (NEVER trust the client). ---
    const feeRows = await tx.fee.findMany({
      where: {
        enabled: true,
        OR: [{ activity_id: activity.id }, { activity_id: null }],
      },
      select: { name: true, type: true, value: true, is_tax: true },
    });
    const fees: PricingFee[] = feeRows.map((f) => ({
      name: f.name,
      type: f.type,
      value: f.value,
      isTax: f.is_tax,
    }));

    // --- Dynamic pricing: resolve this slot's effective per-unit price from the
    //     operator's rules, then reconcile it against the signed quote the guest is
    //     holding, so the price shown at checkout is the price actually charged. ---
    const priced = await reconcileSlotPrice(tx, operatorId, {
      activityId: activity.id,
      rateId: rate.id,
      basePriceCents: rate.price_cents,
      slotStart: timeslot.datetime,
      capacityTotal: timeslot.capacity_total,
      capacityBooked: timeslot.capacity_booked,
      timeslotId: timeslot.id,
      quantity: effectiveQuantity,
      quoteToken: input.priceQuoteToken ?? null,
    });
    if (priced.requiresGuestConfirmation) {
      throw new BookingError(
        'PRICE_CHANGED',
        'The price for this trip changed while you were checking out. Please review the new total.',
        409,
      );
    }
    const dynamicUnitPriceCents = priced.unitPriceCents;

    // --- Resolve + validate any promo code against the DB (server-side). ---
    //     Two paths: (a) the guest typed a code -> validate that exact code; or
    //     (b) no code -> auto-apply the single best active AUTO promo for this
    //     activity. The server is the price authority either way: discount_type /
    //     discount_value are read from the DB, never from the client.
    const promoSelect = {
      id: true,
      discount_type: true,
      discount_value: true,
      valid_from: true,
      valid_until: true,
      max_redemptions: true,
      times_redeemed: true,
      activity_ids: true,
      per_customer_limit: true,
    } as const;
    const normalizedEmail = input.customer.email.trim().toLowerCase();
    const isPromoValid = (
      p: { valid_from: Date | null; valid_until: Date | null; max_redemptions: number | null; times_redeemed: number; activity_ids: string[] },
      now: Date,
    ): boolean =>
      (p.valid_from === null || p.valid_from <= now) &&
      (p.valid_until === null || p.valid_until >= now) &&
      (p.max_redemptions === null || p.times_redeemed < p.max_redemptions) &&
      (p.activity_ids.length === 0 || p.activity_ids.includes(activity.id));

    let promo: PricingPromo | null = null;
    let promoCodeId: string | null = null;
    let promoPerCustomerLimit: number | null = null;
    if (input.promoCode) {
      const code = input.promoCode.trim().toUpperCase();
      const promoRow = await tx.promoCode.findFirst({
        where: { code, is_active: true },
        select: promoSelect,
      });
      const now = new Date();
      if (!promoRow || !isPromoValid(promoRow, now)) {
        throw new BookingError('INVALID_PROMO', 'Promo code is invalid or expired');
      }
      promo = {
        discountType: promoRow.discount_type,
        discountValue: promoRow.discount_value,
      };
      promoCodeId = promoRow.id;
      promoPerCustomerLimit = promoRow.per_customer_limit;
    } else {
      // No code typed: auto-apply the best active AUTO promo. "Best" = the largest
      // actual discount against this line's subtotal (so a FLAT vs PERCENT mix is
      // compared on real cents, not raw numbers).
      const now = new Date();
      const autoRows = await tx.promoCode.findMany({
        where: { is_active: true, auto_apply: true },
        select: promoSelect,
      });
      const lineSubtotalCents = dynamicUnitPriceCents * effectiveQuantity;
      let best: (typeof autoRows)[number] | null = null;
      let bestDiscount = 0;
      for (const p of autoRows) {
        if (!isPromoValid(p, now)) continue;
        const d =
          p.discount_type === 'PERCENT'
            ? Math.round((lineSubtotalCents * p.discount_value) / 100)
            : Math.min(p.discount_value, lineSubtotalCents);
        if (d > bestDiscount) {
          bestDiscount = d;
          best = p;
        }
      }
      if (best) {
        promo = { discountType: best.discount_type, discountValue: best.discount_value };
        promoCodeId = best.id;
        promoPerCustomerLimit = best.per_customer_limit;
      }
    }

    // --- Enforce per-customer redemption limit. Count this customer's prior
    //     redemptions of THIS promo in the ledger; reject if already at the cap.
    //     Runs inside the same transaction that writes the new ledger row below,
    //     so concurrent bookings by the same customer can't both slip past the cap
    //     (the second sees a non-serializable conflict / the committed first row). ---
    if (promoCodeId && promoPerCustomerLimit !== null) {
      const priorRedemptions = await tx.promoRedemption.count({
        where: { promo_code_id: promoCodeId, customer_email: normalizedEmail },
      });
      if (priorRedemptions >= promoPerCustomerLimit) {
        // Typed code -> hard error. Auto-applied -> silently drop the promo so the
        // booking still succeeds at full price.
        if (input.promoCode) {
          throw new BookingError(
            'PROMO_CUSTOMER_LIMIT_REACHED',
            'You have already used this promo code the maximum number of times',
            409,
          );
        }
        promo = null;
        promoCodeId = null;
        promoPerCustomerLimit = null;
      }
    }

    // --- Upsert the customer by (operator, email). ---
    const customer = await tx.customer.upsert({
      where: {
        operator_id_email: { operator_id: operatorId, email: input.customer.email },
      },
      create: {
        operator_id: operatorId,
        first_name: input.customer.first_name,
        last_name: input.customer.last_name,
        email: input.customer.email,
        phone: input.customer.phone ?? null,
        address: input.customer.address ?? null,
        city: input.customer.city ?? null,
        state: input.customer.state ?? null,
        zip: input.customer.zip ?? null,
        total_bookings: 1,
        last_booking_at: new Date(),
      },
      update: {
        first_name: input.customer.first_name,
        last_name: input.customer.last_name,
        phone: input.customer.phone ?? undefined,
        address: input.customer.address ?? undefined,
        city: input.customer.city ?? undefined,
        state: input.customer.state ?? undefined,
        zip: input.customer.zip ?? undefined,
        total_bookings: { increment: 1 },
        last_booking_at: new Date(),
      },
      select: { id: true, created_at: true },
    });
    // A customer whose record predates this transaction is a returning guest.
    const isReturningGuest = customer.created_at.getTime() < Date.now() - 1000;

    // --- Member pricing (Upmarket §1 #6-A): if this customer holds an active
    //     membership, apply its member discount to the (already dynamically-priced)
    //     per-unit price. Best-discount-wins across multiple holdings. Layered ON TOP
    //     of dynamic pricing so a member still benefits from seasonal/weekend rules. ---
    const member = await bestActiveMemberPricing(tx, {
      customerId: customer.id,
      basePriceCents: dynamicUnitPriceCents,
    });
    const unitPriceCents = member
      ? applyMemberPrice(dynamicUnitPriceCents, member.discount)
      : dynamicUnitPriceCents;

    // --- Per-head seat lines. `unitPriceCents` above is the effective BASE per head
    //     (base -> dynamic rules -> member discount). When the request carried a
    //     rate-class breakdown, each class's per-head price is that effective base
    //     PLUS the class's own price_modifier_cents (clamped >= 0), priced
    //     SERVER-SIDE from the class catalog we re-read — never the client. The sum
    //     over counts is the quote, and it is exactly what we charge. Without a
    //     breakdown we synthesize one default "Guest" seat line at the effective
    //     base so the single-quantity path is identical to before. ---
    const classLines: RateClassLine[] = useRateClasses
      ? priceRateClasses(
          unitPriceCents,
          classCatalog.map((c) => ({
            id: c.id,
            label: c.label,
            priceModifierCents: c.price_modifier_cents,
          })),
          requestedClasses,
        ).lines
      : [{ classId: '', label: 'Guest', unitPriceCents, count: effectiveQuantity }];

    // --- Add-ons: re-read + re-price every selection from the catalog (NEVER the
    //     client's price). resolveAddOnLines reads the activity's active add-ons,
    //     resolves each requested quantity against stock + the party size, and
    //     returns priced lines; a client-sent unit price is ignored entirely. The
    //     lines become extra PricingItems in the ONE calculatePricing below (so they
    //     are taxed + fee'd + discounted exactly like the seats — see
    //     services/addons.ts), and extra OrderItem rows on the same insert. Stock is
    //     reserved AFTER capacity is confirmed, further down. ---
    const addOnLines: PricedAddOnLine[] = await resolveAddOnLines(tx, operatorId, {
      activityId: activity.id,
      guestCount: effectiveQuantity,
      selections: input.addOns ?? [],
    });

    // --- Final server-authoritative pricing from the per-head seat lines + DB fees.
    //     Each class is its own PricingItem so a mixed party (e.g. 2 adults + 1
    //     child) sums exactly; a single-class/single-quantity booking is the
    //     one-line case. Add-ons are taxed/fee'd/discounted alongside the seats. ---
    const pricing = calculatePricing({
      items: [
        ...classLines.map((l) => ({ unitPriceCents: l.unitPriceCents, quantity: l.count })),
        ...addOnPricingItems(addOnLines),
      ],
      fees,
      promo,
      tipCents: input.tipCents ?? 0,
    });

    // --- Deposit resolution: activity override, else operator default. When a
    //     deposit applies we charge only the deposit now and leave the remainder
    //     as balance_due (collected at check-in). depositPercent 0 => pay in full. ---
    const depositPercent = resolveDepositPercent(
      activity.deposit_percent,
      operator.default_deposit_percent,
    );
    const depositCents =
      depositPercent > 0 ? computeDepositCents(pricing.totalCents, depositPercent) : 0;
    // Any configured deposit > 0 collects upfront — including the edge where the
    // deposit rounds up to the full total (e.g. a 99–100% deposit), which must still
    // charge, not silently collect nothing. balance_due below correctly nets to 0.
    const takeDeposit = depositCents > 0 && depositCents <= pricing.totalCents;

    // --- Generate a per-location, per-day sequential order number. The sequence
    //     counts orders already numbered for THIS slot-day prefix (not orders
    //     created today): future-dated slots share a day, so counting by
    //     created_at collided every order for that day on seq 1. ---
    const slotDate = timeslot.datetime;
    const numberPrefix = generateOrderNumber(operator.location_code, slotDate, 0).slice(0, -3);
    const seq =
      (await tx.order.count({
        where: { order_number: { startsWith: numberPrefix } },
      })) + 1;
    const orderNumber = generateOrderNumber(operator.location_code, slotDate, seq);

    // --- Attribution (Singenuity §4): resolve an affiliate code to an Affiliate and
    //     snapshot the code onto the order, and record the heard-about-us label + any
    //     custom-question answers. All optional; a bad/unknown affiliate code is simply
    //     not attributed rather than failing the booking. ---
    let affiliateId: string | null = null;
    let affiliateCode: string | null = null;
    if (input.affiliateCode) {
      const code = input.affiliateCode.trim();
      const affiliate = await tx.affiliate.findFirst({
        where: { code, is_active: true },
        select: { id: true, code: true },
      });
      if (affiliate) {
        affiliateId = affiliate.id;
        affiliateCode = affiliate.code;
      }
    }
    const questionAnswers =
      input.questionAnswers && Object.keys(input.questionAnswers).length > 0
        ? (input.questionAnswers as Prisma.InputJsonValue)
        : undefined;

    // --- Create the order + its single item. ---
    const order = await tx.order.create({
      data: {
        operator_id: operatorId,
        order_number: orderNumber,
        customer_id: customer.id,
        status: 'UPCOMING',
        created_by: channel,
        subtotal_cents: pricing.subtotalCents,
        tax_cents: pricing.taxCents,
        processing_fee_cents: pricing.processingFeeCents,
        tip_cents: pricing.tipCents,
        discount_cents: pricing.discountCents,
        total_cents: pricing.totalCents,
        amount_paid_cents: takeDeposit ? depositCents : 0,
        balance_due_cents: takeDeposit ? pricing.totalCents - depositCents : pricing.totalCents,
        promo_code_id: promoCodeId,
        is_returning_guest: isReturningGuest,
        // The de-duplication guard. Writing it as part of the SAME insert that
        // builds the order is what makes the unique index authoritative: there is
        // no window in which an order exists without its key.
        idempotency_key: idempotencyKey,
        items: {
          // operator_id is derived from the parent order via the tenant-composite
          // relation ([operator_id, order_id]); passing it explicitly is now rejected
          // and the DB guarantees the item shares the order's tenant.
          create: [
            // One seat OrderItem per rate-class line — each carries its own quantity
            // and per-head unit_price_cents (so manifest/reports, which already sum
            // quantity * unit_price_cents off OrderItem, stay correct without any
            // class lookup). rate_class_id links back to the class; rate_class_label
            // snapshots the label so a later rename/delete never rewrites this
            // receipt. The single-quantity path is the one-line case (classId ''). The
            // checkout driver/licence info is attached to the FIRST seat line only.
            ...classLines.map((line, idx) => ({
              activity_id: activity.id,
              rate_id: rate.id,
              timeslot_id: timeslot.id,
              quantity: line.count,
              unit_price_cents: line.unitPriceCents,
              rate_class_id: line.classId !== '' ? line.classId : null,
              rate_class_label: line.label,
              status: 'UPCOMING' as const,
              driver_name: idx === 0 ? input.participants[0]?.driver_name ?? null : null,
              license_number: idx === 0 ? input.participants[0]?.license ?? null : null,
              date_of_birth:
                idx === 0 && input.participants[0]?.dob
                  ? new Date(input.participants[0].dob)
                  : null,
            })),
            // Add-on lines, server-priced, as sibling OrderItems on the same insert —
            // so a rolled-back booking leaves no orphan add-on. They carry add_on_id
            // (what isSeatItem/seatCount exclude as a non-seat) + a name snapshot.
            ...buildAddOnOrderItems(addOnLines, {
              activityId: activity.id,
              rateId: rate.id,
              timeslotId: timeslot.id,
            }),
          ],
        },
      },
      include: BOOKING_ORDER_INCLUDE,
    });

    // --- Increment timeslot capacity + recompute its display status. ---
    const newBooked = timeslot.capacity_booked + effectiveQuantity;
    await tx.timeslot.update({
      where: { id: timeslot.id },
      data: {
        capacity_booked: newBooked,
        status: computeSlotStatus(timeslot.capacity_total, newBooked),
      },
    });

    // --- Consume the cart hold that backed this checkout. The seats it reserved
    //     are now real booked capacity (incremented above), so the hold must stop
    //     subtracting from availability too — otherwise this slot would be
    //     double-debited for the same seats. No-op when there is no hold (staff/
    //     POS) or it expired/mismatched; the FOR UPDATE check above is authoritative. ---
    if (options.holdId) {
      await consumeHold(tx, { holdId: options.holdId, timeslotId: timeslot.id });
    }

    // --- Commit add-on stock. A single conditional UPDATE per line whose WHERE
    //     carries the invariant, so two guests racing for the last cooler can't both
    //     win (services/addons.ts). Done AFTER the seats are secured so a booking that
    //     fails on capacity never first consumes stock; a sold-out line throws and
    //     rolls back the whole booking. No-op when there are no add-ons. ---
    await reserveAddOnStock(tx, operatorId, addOnLines);

    // --- Record the inline liability-waiver signature captured at checkout. ---
    //     The customer app collects a required acceptance + a typed full legal name
    //     (WaiverSection); those flow here so the signature is not silently dropped
    //     (a liability gap). We flag the order item waiver_signed and, when the
    //     operator has an active waiver, write a WaiverSignature audit row bound to
    //     that waiver's current version with the typed name as the signature data.
    //     A missing/empty acceptance is a no-op — staff/API flows that sign the full
    //     clause-based waiver via /api/waivers/sign are unaffected.
    const waiverAcceptance = input.waiverAcceptance;
    if (
      activity.waiver_required &&
      waiverAcceptance?.accepted &&
      waiverAcceptance.signatureName.trim().length > 0
    ) {
      const signedAt = new Date();
      const signerName = waiverAcceptance.signatureName.trim();
      const orderItemId = order.items[0]!.id;

      await tx.orderItem.update({
        where: { id: orderItemId },
        data: { waiver_signed: true, waiver_signed_at: signedAt },
      });
      await tx.customer.update({
        where: { id: customer.id },
        data: { waiver_on_file: true },
      });

      // Bind the audit record to the operator's active waiver when one exists. The
      // typed name is the signature (signature_data); acknowledgments stays null
      // because the inline checkout waiver is a single-acceptance release, not the
      // per-clause flow. Without an active waiver we still flag the item above, so
      // the check-in manifest no longer shows "Waiver needed" for a guest who signed.
      const activeWaiver = await tx.waiver.findFirst({
        where: { is_active: true },
        select: { id: true, version: true },
      });
      if (activeWaiver) {
        await tx.waiverSignature.create({
          data: {
            operator_id: operatorId,
            waiver_id: activeWaiver.id,
            order_item_id: orderItemId,
            customer_id: customer.id,
            signer_name: signerName,
            signed_at: signedAt,
            signature_data: signerName,
            ip_address: null,
            waiver_version: activeWaiver.version,
          },
        });
      }
    }

    // --- Reserve the shared resources this booking consumes for its window. ---
    if (pools.length > 0) {
      await writeResourceBookings(tx, {
        operatorId,
        orderItemId: order.items[0]!.id,
        pools,
        seats: effectiveQuantity,
        startsAt,
        endsAt,
      });
    }

    // --- Bump promo redemption count when one was applied. Atomic guarded update:
    //     the increment only lands while the code is still under its limit, so two
    //     concurrent bookings can't both push a limited promo past max_redemptions
    //     (the loser matches 0 rows and the whole booking rolls back). ---
    if (promoCodeId) {
      const bumped = await tx.$executeRaw`
        UPDATE "PromoCode"
        SET times_redeemed = times_redeemed + 1
        WHERE id = ${promoCodeId}
          AND (max_redemptions IS NULL OR times_redeemed < max_redemptions)`;
      if (bumped === 0) {
        throw new BookingError('PROMO_LIMIT_REACHED', 'This promo code has reached its redemption limit', 409);
      }
      // Ledger row: one per actual redemption, keyed to the customer so the
      // per-customer cap counted above has something to count next time.
      await tx.promoRedemption.create({
        data: {
          operator_id: operatorId,
          promo_code_id: promoCodeId,
          customer_id: customer.id,
          customer_email: normalizedEmail,
          order_id: order.id,
        },
      });
    }

    // --- Punch-card memberships: spend one use per seat booked. No-op for
    //     unlimited passes / member-rate tiers (null remaining_uses). Depletes the
    //     holding when it hits zero so it stops granting member pricing. ---
    if (member && member.kind === 'PUNCH_CARD') {
      await consumeMembershipUses(tx, member.customerMembershipId, effectiveQuantity);
    }

    // --- Keep customer lifetime value roughly in sync (booking-time estimate). ---
    await tx.customer.update({
      where: { id: customer.id },
      data: { lifetime_value_cents: { increment: pricing.totalCents } },
    });

    // --- Audit trail. ---
    await tx.orderEvent.create({
      data: {
        operator_id: operatorId,
        order_id: order.id,
        type: 'ORDER_CREATED',
        description: `Booking ${orderNumber} created via ${channel.toLowerCase()} channel`,
        actor: options.actor ?? null,
        metadata: {
          channel,
          quantity: effectiveQuantity,
          totalCents: pricing.totalCents,
          timeslotId: timeslot.id,
          // Record what this create consumed so a later release (declined/abandoned
          // checkout -> cancelBooking) can reverse it. Promo bump is recoverable from
          // order.promo_code_id; the punch-card spend is not (the "best active"
          // holding chosen here can't be reconstructed at cancel time), so we snapshot
          // the exact holding id + punches spent. No schema change — metadata is Json.
          ...(member && member.kind === 'PUNCH_CARD'
            ? { consumedMembershipId: member.customerMembershipId, consumedPunches: effectiveQuantity }
            : {}),
        } as Prisma.InputJsonValue,
      },
    });

    // --- Deposit charge: when a deposit applies, record the (simulated) card
    //     charge for the deposit amount and audit it. The order's amount_paid /
    //     balance_due were already set to the deposit split above; this writes the
    //     matching Payment ledger row so the two never drift. In fake-payments dev
    //     mode this never touches Stripe; when payments aren't configured at all we
    //     still split the ledger but skip the Payment row (no processor to charge). ---
    const depositProvider = takeDeposit ? await getPaymentProvider(operatorId) : null;
    if (takeDeposit && depositProvider && depositProvider.providerKey !== 'none') {
      // Derived from the order id, so it is stable across a retry of this order and
      // distinct from every other order's deposit. A replayed submit never reaches
      // here at all (the order insert above loses the race first), so this guards
      // the narrower case of a crash between "processor accepted" and "row written".
      const depositKey = `deposit-${order.id}`;
      // settledOrThrow: a service-layer deposit has no route to answer a 3DS
      // challenge from, so anything but success throws (exactly what the pre-seam
      // driver did) and aborts the booking transaction cleanly.
      const charge = settledOrThrow(
        await depositProvider.charge({
          orderId: order.id,
          tokenizedSource: 'deposit',
          amountCents: depositCents,
          idempotencyKey: depositKey,
          // We are inside the transaction that created this order, so the simulator
          // cannot look the tenant up yet — hand it over.
          operatorId,
        }),
      );
      await tx.payment.create({
        data: {
          operator_id: operatorId,
          order_id: order.id,
          method: 'CARD',
          status: 'PAID',
          amount_cents: depositCents,
          card_brand: charge.cardBrand,
          card_last_four: charge.cardLastFour,
          cardholder_name: charge.cardholderName,
          processor: 'STRIPE',
          processor_transaction_id: charge.paymentRef,
          idempotency_key: depositKey,
        },
      });
      await tx.orderEvent.create({
        data: {
          operator_id: operatorId,
          order_id: order.id,
          type: 'DEPOSIT',
          description: `Deposit of ${(depositCents / 100).toFixed(2)} USD collected (${depositPercent}% of total); ${((pricing.totalCents - depositCents) / 100).toFixed(2)} USD due at check-in`,
          actor: options.actor ?? 'customer',
          metadata: {
            depositPercent,
            depositCents,
            balanceDueCents: pricing.totalCents - depositCents,
            totalCents: pricing.totalCents,
          } as Prisma.InputJsonValue,
        },
      });
    }

    return order;
  });
}

/**
 * A built-in cancellation policy used ONLY when neither the Activity nor the
 * Operator has one configured. It is deliberately a FULL REFUND at any time: a
 * missing policy must never silently keep a guest's money. An operator who wants
 * to withhold anything has to say so explicitly by configuring a policy.
 */
const SAFE_DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
  tiers: [{ min_hours_before: 0, refund_percent: 100 }],
  cancellation_fee_cents: 0,
  fee_scope: 'order',
  self_cancel_hours: 0,
  refund_method: 'card',
};

/**
 * Coerce an untyped JSON blob (Activity/Operator.cancellation_policy) into a
 * CancellationPolicy, or null when it is absent / not an object. The stored shape
 * is validated at write time; here we only guard against null/garbage so a
 * malformed row degrades to "no policy at this level" rather than throwing inside
 * a money mutation.
 */
function coercePolicy(raw: unknown): CancellationPolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<CancellationPolicy>;
  if (!Array.isArray(p.tiers)) return null;
  return {
    tiers: p.tiers,
    cancellation_fee_cents: Math.max(0, Number(p.cancellation_fee_cents ?? 0) | 0),
    fee_scope: p.fee_scope === 'guest' ? 'guest' : 'order',
    self_cancel_hours: Math.max(0, Number(p.self_cancel_hours ?? 0)),
    refund_method:
      p.refund_method === 'gift_card' || p.refund_method === 'card_then_gift'
        ? p.refund_method
        : 'card',
  };
}

/** The outcome of the refund leg of a cancellation, surfaced on the return value. */
export interface CancellationRefundSummary {
  /** Tier percent applied (0-100). */
  tierPercent: number;
  /** Total cents the policy decided to refund. */
  refundCents: number;
  /** Cancellation fee withheld (cents). */
  feeCents: number;
  /** Of the refund, how much went back to the card. */
  cardRefundCents: number;
  /** Of the refund, how much was issued as gift-card credit. */
  giftRefundCents: number;
}

/** Options for {@link cancelBooking}. */
export interface CancelBookingOptions {
  /** Audit actor for the OrderEvent. */
  actor?: string;
  /** Free-text cancellation reason, recorded on the event. */
  reason?: string;
  /**
   * Whether to compute + issue a refund per the effective cancellation policy.
   * Defaults to true. The pre-payment release path (releaseDeclinedOrder, a
   * declined/abandoned checkout) passes false: nothing settled, so there is
   * nothing to refund and no policy to apply.
   */
  refund?: boolean;
  /**
   * Channel requesting the cancellation. STAFF/KIOSK ignore `self_cancel_hours`;
   * CUSTOMER is subject to it when `enforceSelfCancelWindow` is set. Defaults to
   * STAFF (the only caller today; the self-service phase passes CUSTOMER).
   */
  channel?: BookingChannel;
  /**
   * When true AND channel is CUSTOMER, refuse the cancel if `now` is past the
   * policy's self-cancel cutoff. Staff cancels always ignore this. Defaults to
   * false so staff and the existing callers are never gated. The self-service
   * phase turns it on.
   */
  enforceSelfCancelWindow?: boolean;
}

/**
 * Cancel an order: marks it (and its items) CANCELLED, restores the capacity it
 * held on each timeslot, computes + issues the tiered cancellation refund, and
 * records OrderEvent(s). Idempotent guard prevents double-restoring capacity (and
 * double-refunding) for an already-cancelled order. Runs in a tenant transaction
 * so RLS scopes every write.
 *
 * MONEY PATH — refund:
 *   - The Order row is locked `FOR UPDATE` first (same pattern as collectBalance)
 *     so a concurrent collect-balance / gift redeem / second cancel serialises
 *     behind us and can never read a stale balance.
 *   - The effective policy is Activity.cancellation_policy ?? Operator
 *     .cancellation_policy ?? a safe full-refund default.
 *   - The refund amount is computed from `amount_paid_cents`, the booking's
 *     EARLIEST item start, `now`, and the guest count, by the pure
 *     `computeCancellationRefund` core helper.
 *   - The card portion goes back through the existing PaymentProvider refund path
 *     (reused verbatim, never reinvented); the gift portion (when refund_method
 *     includes gift) is credited back to the gift card(s) used on the order.
 *   - Idempotent: once the order is CANCELLED the ALREADY_CANCELLED guard makes
 *     the whole thing (capacity, consumption reversal, AND refund) run at most
 *     once, so a refund can never be issued twice.
 */
export async function cancelBooking(
  operatorId: string,
  orderId: string,
  options: CancelBookingOptions = {},
) {
  const issueRefund = options.refund !== false;
  const channel: BookingChannel = options.channel ?? 'STAFF';
  const now = new Date();

  // The provider is resolved once, outside the transaction (it may do I/O to read
  // the operator's Integration keys). A `none` provider is only a hard failure if
  // there is actually a card refund to issue — decided below after we know the
  // amount; here we just hold the handle.
  const paymentProvider = issueRefund ? await getPaymentProvider(operatorId) : null;

  const {
    order: cancelled,
    freedTimeslotIds,
    refundSummary,
  } = await withTenant(operatorId, async (tx) => {
    // Lock the Order row FOR UPDATE before reading the ledger — the collectBalance
    // pattern. Serialises every money writer on this order (collect-balance, gift
    // redeem, a second cancel) so none reads a stale amount_paid / balance_due.
    const locked = await tx.$queryRaw<
      Array<{ id: string; status: string; total_cents: number; amount_paid_cents: number }>
    >`
      SELECT id, status, total_cents, amount_paid_cents
      FROM "Order"
      WHERE id = ${orderId}
      FOR UPDATE`;
    if (locked.length === 0) {
      throw new BookingError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    // Re-read via Prisma now that the row is locked, so includes/typing match the
    // rest of the function. The FOR UPDATE above is what holds the row.
    const order = await tx.order.findFirst({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) {
      throw new BookingError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    if (order.status === 'CANCELLED') {
      throw new BookingError('ALREADY_CANCELLED', 'Order is already cancelled', 409);
    }

    // --- Resolve the effective cancellation policy + compute the refund -------
    //
    // Only when we are actually issuing a refund (the pre-payment release path
    // passes refund:false and skips all of this — nothing settled). The policy is
    // Activity override -> Operator default -> safe built-in full-refund default.
    // We read it off the booking's items, taking the earliest start as the
    // reference instant the tier is measured against.
    const activeItems = order.items.filter((i) => i.status !== 'CANCELLED');
    let refundSummary: CancellationRefundSummary | null = null;

    if (issueRefund) {
      // Earliest item start on the order — the most generous reading for the guest
      // when an order spans several timeslots.
      let earliestStart: Date | null = null;
      let activityPolicyRaw: unknown = null;
      for (const item of activeItems) {
        const slot = await tx.timeslot.findFirst({
          where: { id: item.timeslot_id },
          select: { datetime: true },
        });
        if (slot && (earliestStart === null || slot.datetime < earliestStart)) {
          earliestStart = slot.datetime;
        }
        if (activityPolicyRaw === null) {
          const activity = await tx.activity.findFirst({
            where: { id: item.activity_id },
            select: { cancellation_policy: true },
          });
          activityPolicyRaw = activity?.cancellation_policy ?? null;
        }
      }

      const operator = await tx.operator.findFirst({
        where: { id: operatorId },
        select: { cancellation_policy: true },
      });

      const policy: CancellationPolicy =
        coercePolicy(activityPolicyRaw) ??
        coercePolicy(operator?.cancellation_policy ?? null) ??
        SAFE_DEFAULT_CANCELLATION_POLICY;

      // Guests on the order = sum of active item quantities (for per-guest fees).
      const guestCount = activeItems.reduce((n, i) => n + i.quantity, 0) || 1;

      const computed = computeCancellationRefund({
        policy,
        // A missing start (orphaned slot) is treated as "already started": no tier
        // qualifies beyond a 0h tier, which is the conservative read.
        startsAt: earliestStart ?? now,
        now,
        amountPaidCents: order.amount_paid_cents,
        guestCount,
      });

      // Self-cancel window: staff/kiosk always bypass; a CUSTOMER cancel is gated
      // only when the caller asks for it (the self-service phase). Checked BEFORE
      // any mutation so a refused cancel changes nothing.
      if (
        options.enforceSelfCancelWindow &&
        channel === 'CUSTOMER' &&
        !computed.withinSelfCancelWindow
      ) {
        throw new BookingError(
          'SELF_CANCEL_WINDOW_CLOSED',
          'This booking can no longer be cancelled online — please contact us.',
          409,
        );
      }

      // --- Issue the refund (card portion through the PaymentProvider) ---------
      //
      // Split the policy's refund across the instruments actually used on the
      // order: the card-settled portion goes back to the card via the existing
      // provider refund path; any remainder (only when refund_method includes
      // gift) becomes gift-card credit. A card-only policy with no refundable card
      // payment simply refunds 0 to the card.
      let cardRefundCents = 0;
      let giftRefundCents = 0;

      if (computed.refundCents > 0) {
        // The order's PAID payments, split by instrument. Card payments with a
        // processor handle are the only ones the provider can refund.
        const payments = await tx.payment.findMany({
          where: { order_id: order.id, status: { in: ['PAID', 'PARTIAL_REFUND'] } },
          orderBy: { processed_at: 'asc' },
        });

        const wantsGift =
          policy.refund_method === 'gift_card' || policy.refund_method === 'card_then_gift';
        const giftOnly = policy.refund_method === 'gift_card';

        let remaining = computed.refundCents;

        // 1) Card refunds — unless the policy says disburse everything as gift.
        if (!giftOnly) {
          for (const p of payments) {
            if (remaining <= 0) break;
            if (p.method !== 'CARD') continue;
            if (p.processor !== 'STRIPE' || !p.processor_transaction_id) continue;
            const headroom = p.amount_cents - p.refunded_cents;
            if (headroom <= 0) continue;
            const chunk = Math.min(headroom, remaining);

            if (!paymentProvider || paymentProvider.providerKey === 'none') {
              throw new BookingError(
                'PAYMENTS_NOT_CONFIGURED',
                'Payments are not configured; cannot issue the card refund',
                501,
              );
            }

            // Reuse the existing provider refund path verbatim.
            const result = await paymentProvider.refund({
              paymentRef: p.processor_transaction_id,
              amountCents: chunk,
              reason: options.reason,
              operatorId,
            });

            // Atomic compare-and-swap on refunded_cents — the same guard the
            // staff refund route uses so two refunds can't both compute from a
            // stale refunded_cents and over-refund past what the card captured.
            const cas = await tx.payment.updateMany({
              where: { id: p.id, refunded_cents: { lte: p.amount_cents - chunk } },
              data: { refunded_cents: { increment: chunk } },
            });
            if (cas.count === 0) {
              throw new BookingError(
                'REFUND_CONFLICT',
                'A concurrent refund changed this payment; retry',
                409,
              );
            }
            const reread = await tx.payment.findUniqueOrThrow({ where: { id: p.id } });
            await tx.payment.update({
              where: { id: p.id },
              data: {
                status: reread.refunded_cents >= p.amount_cents ? 'REFUNDED' : 'PARTIAL_REFUND',
              },
            });

            await tx.orderEvent.create({
              data: {
                operator_id: operatorId,
                order_id: order.id,
                type: 'REFUND',
                description: `Refunded ${(chunk / 100).toFixed(2)} USD to card${
                  options.reason ? ` — ${options.reason}` : ''
                }`,
                actor: options.actor ?? null,
                metadata: {
                  paymentId: p.id,
                  processorRefundId: result.refundRef,
                  processorRefundStatus: result.status,
                  amountCents: chunk,
                  kind: 'cancellation',
                } as Prisma.InputJsonValue,
              },
            });

            cardRefundCents += chunk;
            remaining -= chunk;
          }
        }

        // 2) Gift-card credit — the remainder, when the policy disburses to gift.
        //    Credit back to the gift card(s) the order paid with (increment the
        //    stored balance, un-redeem a depleted card). A refund Payment row with
        //    a negative amount records the credit on the ledger.
        if (wantsGift && remaining > 0) {
          for (const p of payments) {
            if (remaining <= 0) break;
            if (p.method !== 'GIFT_CARD' || !p.gift_card_id) continue;
            const headroom = p.amount_cents - p.refunded_cents;
            if (headroom <= 0) continue;
            const chunk = Math.min(headroom, remaining);

            const cas = await tx.payment.updateMany({
              where: { id: p.id, refunded_cents: { lte: p.amount_cents - chunk } },
              data: { refunded_cents: { increment: chunk } },
            });
            if (cas.count === 0) {
              throw new BookingError(
                'REFUND_CONFLICT',
                'A concurrent refund changed this payment; retry',
                409,
              );
            }
            const reread = await tx.payment.findUniqueOrThrow({ where: { id: p.id } });
            await tx.payment.update({
              where: { id: p.id },
              data: {
                status: reread.refunded_cents >= p.amount_cents ? 'REFUNDED' : 'PARTIAL_REFUND',
              },
            });

            // Credit the stored-value card back + revive a depleted one.
            await tx.giftCard.updateMany({
              where: { id: p.gift_card_id, operator_id: operatorId },
              data: { balance_cents: { increment: chunk } },
            });
            await tx.giftCard.updateMany({
              where: { id: p.gift_card_id, operator_id: operatorId, status: 'REDEEMED' },
              data: { status: 'ACTIVE' },
            });

            await tx.orderEvent.create({
              data: {
                operator_id: operatorId,
                order_id: order.id,
                type: 'REFUND',
                description: `Credited ${(chunk / 100).toFixed(2)} USD to gift card${
                  options.reason ? ` — ${options.reason}` : ''
                }`,
                actor: options.actor ?? null,
                metadata: {
                  paymentId: p.id,
                  giftCardId: p.gift_card_id,
                  amountCents: chunk,
                  kind: 'cancellation_gift',
                } as Prisma.InputJsonValue,
              },
            });

            giftRefundCents += chunk;
            remaining -= chunk;
          }
        }
      }

      refundSummary = {
        tierPercent: computed.tierPercent,
        refundCents: cardRefundCents + giftRefundCents,
        feeCents: computed.feeCents,
        cardRefundCents,
        giftRefundCents,
      };
    }

    // Restore capacity for each non-cancelled item's timeslot.
    for (const item of order.items) {
      if (item.status === 'CANCELLED') continue;
      const slot = await tx.timeslot.findFirst({
        where: { id: item.timeslot_id },
        select: { capacity_total: true, capacity_booked: true, status: true },
      });
      if (!slot) continue;
      const newBooked = Math.max(0, slot.capacity_booked - item.quantity);
      await tx.timeslot.update({
        where: { id: item.timeslot_id },
        data: {
          capacity_booked: newBooked,
          // Don't resurrect a cancelled slot; otherwise recompute from capacity.
          status:
            slot.status === 'CANCELLED'
              ? 'CANCELLED'
              : computeSlotStatus(slot.capacity_total, newBooked),
        },
      });
    }

    // Free every resource reservation the (soon-to-be) cancelled items held.
    await releaseResourceBookings(
      tx,
      order.items.filter((i) => i.status !== 'CANCELLED').map((i) => i.id),
    );

    await tx.orderItem.updateMany({
      where: { order_id: order.id, status: { not: 'CANCELLED' } },
      data: { status: 'CANCELLED' },
    });

    // Reverse the one-time consumptions the create tx made but payment never
    // settled. createBooking bumps a promo's redemption count and spends punch-card
    // uses up front, in a tx separate from the later payment; a declined/abandoned
    // checkout routes here via releaseDeclinedOrder, so without this an unpaid,
    // never-completed booking permanently burns a promo redemption and a guest's
    // punch(es). The ALREADY_CANCELLED guard above makes this run at most once.
    //
    // Promo: guarded decrement so a hand-reset counter never goes negative.
    if (order.promo_code_id) {
      await tx.$executeRaw`
        UPDATE "PromoCode"
        SET times_redeemed = GREATEST(0, times_redeemed - 1)
        WHERE id = ${order.promo_code_id}`;
      // Reverse the per-customer ledger row too (narrow where: just this order's
      // redemption of this promo) so a cancelled booking frees the customer's slot.
      await tx.promoRedemption.deleteMany({
        where: { order_id: order.id, promo_code_id: order.promo_code_id },
      });
    }
    // Punch card: restore the exact holding + count snapshotted on ORDER_CREATED
    // (the only durable record of which holding priced this booking). Flip a
    // DEPLETED holding back to ACTIVE now that it has uses again.
    const createEvent = await tx.orderEvent.findFirst({
      where: { order_id: order.id, type: 'ORDER_CREATED' },
      orderBy: { created_at: 'asc' },
      select: { metadata: true },
    });
    const meta = (createEvent?.metadata ?? null) as {
      consumedMembershipId?: unknown;
      consumedPunches?: unknown;
    } | null;
    const consumedMembershipId =
      meta && typeof meta.consumedMembershipId === 'string' ? meta.consumedMembershipId : null;
    const consumedPunches =
      meta && typeof meta.consumedPunches === 'number' ? meta.consumedPunches : 0;
    if (consumedMembershipId && consumedPunches > 0) {
      const holding = await tx.customerMembership.findUnique({
        where: { id: consumedMembershipId },
        select: { remaining_uses: true, status: true },
      });
      // Only restore a punch card (non-null remaining_uses); never resurrect a
      // membership the customer has since cancelled.
      if (holding && holding.remaining_uses != null && holding.status !== 'CANCELLED') {
        await tx.customerMembership.update({
          where: { id: consumedMembershipId },
          data: {
            remaining_uses: holding.remaining_uses + consumedPunches,
            status: holding.status === 'DEPLETED' ? 'ACTIVE' : holding.status,
          },
        });
      }
    }

    // Roll the order's money state back by whatever was actually refunded. The
    // card+gift refunds above moved money OUT; amount_paid drops by that total and
    // balance_due is recomputed off the (unchanged) total so the ledger stays
    // total = amount_paid + balance_due. A 0-refund tier leaves both untouched —
    // the money stays retained against the cancelled order (an open liability).
    const totalRefunded = refundSummary?.refundCents ?? 0;
    const newAmountPaid = Math.max(0, order.amount_paid_cents - totalRefunded);
    const newBalanceDue = order.total_cents - newAmountPaid;

    const updated = await tx.order.update({
      where: { id: order.id },
      data: {
        status: 'CANCELLED',
        ...(totalRefunded > 0
          ? { amount_paid_cents: newAmountPaid, balance_due_cents: newBalanceDue }
          : {}),
      },
      include: {
        items: { include: { activity: true, rate: true, timeslot: true } },
        customer: true,
      },
    });

    await tx.orderEvent.create({
      data: {
        operator_id: operatorId,
        order_id: order.id,
        type: 'ORDER_CANCELLED',
        description: options.reason
          ? `Order ${order.order_number} cancelled: ${options.reason}`
          : `Order ${order.order_number} cancelled`,
        actor: options.actor ?? null,
        metadata: {
          reason: options.reason ?? null,
          channel,
          // The refund decision, captured on the cancel event itself so a single
          // row explains what happened to the money (the per-leg REFUND events
          // above carry the processor handles).
          ...(refundSummary
            ? {
                tierPercent: refundSummary.tierPercent,
                refundCents: refundSummary.refundCents,
                feeCents: refundSummary.feeCents,
                cardRefundCents: refundSummary.cardRefundCents,
                giftRefundCents: refundSummary.giftRefundCents,
                amountPaidBeforeCents: order.amount_paid_cents,
                amountPaidAfterCents: newAmountPaid,
              }
            : {}),
        } as Prisma.InputJsonValue,
      },
    });

    // The timeslots whose seats this cancel just handed back — the waitlist
    // notify below (OUTSIDE the transaction) offers them to waiting guests.
    const freed = order.items.filter((i) => i.status !== 'CANCELLED').map((i) => i.timeslot_id);

    return { order: updated, freedTimeslotIds: freed, refundSummary };
  });

  // Capacity is free as of the COMMIT above, so now (and only now) offer it to
  // the waitlist. Fire-and-forget: this must never block or fail a cancellation
  // — the exact contract dispatchBookingNotifications has on the create path.
  queueWaitlistNotifications(operatorId, freedTimeslotIds);

  // Tell the guest their booking was cancelled (email + SMS). Same fire-and-forget
  // contract as the waitlist notify above and the create-path confirmation: it runs
  // off the response path, reads the refund facts back off the just-committed
  // ORDER_CANCELLED event, and never throws — so it can't block or fail the cancel.
  dispatchCancellationNotifications(operatorId, orderId);

  // Attach the refund decision as a non-persisted property so the route can
  // surface it without a second query. Enumerable but not part of the DB row.
  return Object.assign(cancelled, { refundSummary });
}

/** What {@link previewCancellationRefund} reports to the self-service UI. */
export interface CancellationPreview {
  /** The applicable tier percent (0-100) at `now`. */
  tierPercent: number;
  /** Cents that would be refunded if the guest cancels now. */
  refundCents: number;
  /** Cancellation fee that would be withheld (cents). */
  feeCents: number;
  /** Cents the guest has paid — the ceiling the refund is clamped to. */
  amountPaidCents: number;
  /**
   * True when `now` is still before the policy's self-cancel cutoff, i.e. the
   * guest may self-cancel online. When false the UI must route them to a call.
   */
  withinSelfCancelWindow: boolean;
  /** The policy's self-cancel cutoff (hours before start), for the UI copy. */
  selfCancelHours: number;
}

/**
 * Read-only preview of what cancelling an order NOW would refund, and whether the
 * guest is still inside the self-cancel window. Pure read — mutates nothing — so
 * the self-service UI can show the refund + policy before the guest confirms.
 *
 * Resolves the SAME effective policy as {@link cancelBooking} (Activity override ->
 * Operator default -> safe full-refund default) and runs the SAME pure
 * `computeCancellationRefund` against the booking's earliest active item start, so
 * the number shown here is exactly the number the cancel will produce at the same
 * instant. Throws BookingError('ORDER_NOT_FOUND') / ('ALREADY_CANCELLED') to match
 * the cancel path's guards.
 */
export async function previewCancellationRefund(
  operatorId: string,
  orderId: string,
): Promise<CancellationPreview> {
  const now = new Date();
  return withTenant(operatorId, async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) {
      throw new BookingError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    if (order.status === 'CANCELLED') {
      throw new BookingError('ALREADY_CANCELLED', 'Order is already cancelled', 409);
    }

    const activeItems = order.items.filter((i) => i.status !== 'CANCELLED');

    // Earliest active item start + the first activity's policy override — the same
    // reads cancelBooking makes when it computes the real refund.
    let earliestStart: Date | null = null;
    let activityPolicyRaw: unknown = null;
    for (const item of activeItems) {
      const slot = await tx.timeslot.findFirst({
        where: { id: item.timeslot_id },
        select: { datetime: true },
      });
      if (slot && (earliestStart === null || slot.datetime < earliestStart)) {
        earliestStart = slot.datetime;
      }
      if (activityPolicyRaw === null) {
        const activity = await tx.activity.findFirst({
          where: { id: item.activity_id },
          select: { cancellation_policy: true },
        });
        activityPolicyRaw = activity?.cancellation_policy ?? null;
      }
    }

    const operator = await tx.operator.findFirst({
      where: { id: operatorId },
      select: { cancellation_policy: true },
    });

    const policy: CancellationPolicy =
      coercePolicy(activityPolicyRaw) ??
      coercePolicy(operator?.cancellation_policy ?? null) ??
      SAFE_DEFAULT_CANCELLATION_POLICY;

    const guestCount = activeItems.reduce((n, i) => n + i.quantity, 0) || 1;

    const computed = computeCancellationRefund({
      policy,
      startsAt: earliestStart ?? now,
      now,
      amountPaidCents: order.amount_paid_cents,
      guestCount,
    });

    return {
      tierPercent: computed.tierPercent,
      refundCents: computed.refundCents,
      feeCents: computed.feeCents,
      amountPaidCents: order.amount_paid_cents,
      withinSelfCancelWindow: computed.withinSelfCancelWindow,
      selfCancelHours: policy.self_cancel_hours,
    };
  });
}

/**
 * Move a booking's item to a different timeslot of the SAME activity — the
 * customer self-service reschedule (and the staff equivalent). Runs in a tenant
 * transaction so RLS scopes every write and the capacity move is atomic:
 *   - validates the new slot belongs to the item's activity, isn't cancelled, and
 *     has room for the item's quantity;
 *   - for the CUSTOMER channel, enforces the activity's `self_reschedule_hours`
 *     window against the CURRENT slot (staff/kiosk bypass the window);
 *   - restores capacity on the old slot and takes it on the new one (recomputing
 *     each slot's display status), repoints the item, and logs an OrderEvent.
 *
 * Operates on the order's single active item by default; pass `orderItemId` to
 * disambiguate a multi-item order.
 */
export async function rescheduleBooking(
  operatorId: string,
  orderId: string,
  newTimeslotId: string,
  options: { actor?: string; channel?: BookingChannel; orderItemId?: string } = {},
) {
  const channel: BookingChannel = options.channel ?? 'CUSTOMER';

  const { order: rescheduled, freedTimeslotId } = await withTenant(operatorId, async (tx) => {
    const order = await tx.order.findFirst({ where: { id: orderId }, include: { items: true } });
    if (!order) {
      throw new BookingError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    if (order.status === 'CANCELLED') {
      throw new BookingError('ORDER_CANCELLED', 'This order has been cancelled', 409);
    }

    // Pick the item to move: the named one, or the sole active item.
    const activeItems = order.items.filter((i) => i.status !== 'CANCELLED');
    let item;
    if (options.orderItemId) {
      item = activeItems.find((i) => i.id === options.orderItemId);
      if (!item) throw new BookingError('ITEM_NOT_FOUND', 'Order item not found on this order', 404);
    } else if (activeItems.length === 1) {
      item = activeItems[0]!;
    } else if (activeItems.length === 0) {
      throw new BookingError('NO_ACTIVE_ITEMS', 'This order has nothing to reschedule', 409);
    } else {
      throw new BookingError('AMBIGUOUS_ITEM', 'Specify which item to reschedule', 400);
    }

    if (item.timeslot_id === newTimeslotId) {
      throw new BookingError('SAME_TIMESLOT', 'The booking is already on that timeslot', 400);
    }

    // --- Lock BOTH slots FOR UPDATE before reading capacity. ---
    //
    // A reschedule frees the old slot and takes the new one; both writes are
    // check-then-increment over capacity_booked and so carry the exact oversell
    // TOCTOU that createBookingAttempt guards (see the note at its lock). Under
    // READ COMMITTED two concurrent reschedules onto the last seat both read
    // stale capacity and both increment, and a stale old-slot release can clobber
    // a concurrent create's increment. We SELECT ... FOR UPDATE both rows up
    // front, sorted by id so two reschedules swapping the same pair can't
    // deadlock, then use the locked snapshot as the source of truth for the
    // check-and-move below (held to COMMIT, so the whole handoff is atomic).
    const lockIds = [item.timeslot_id, newTimeslotId].sort();
    const lockedSlots = await tx.$queryRaw<
      Array<{
        id: string;
        datetime: Date;
        capacity_total: number;
        capacity_booked: number;
        status: string;
      }>
    >`
      SELECT id, datetime, capacity_total, capacity_booked, status
      FROM "Timeslot"
      WHERE id IN (${Prisma.join(lockIds)})
      ORDER BY id ASC
      FOR UPDATE`;

    // Current slot + the activity's self-reschedule policy window.
    const currentSlot = lockedSlots.find((s) => s.id === item.timeslot_id) ?? null;
    const activity = await tx.activity.findFirst({
      where: { id: item.activity_id },
      select: { self_reschedule_hours: true },
    });

    if (channel === 'CUSTOMER' && currentSlot) {
      const windowHours = activity?.self_reschedule_hours ?? 0;
      const cutoffMs = currentSlot.datetime.getTime() - windowHours * 3_600_000;
      if (Date.now() > cutoffMs) {
        throw new BookingError(
          'RESCHEDULE_WINDOW_CLOSED',
          `Online reschedule closes ${windowHours} hour(s) before the start time. Please contact us.`,
          409,
        );
      }
    }

    // New slot: must belong to the same activity, be bookable, and have room.
    // Read from the locked snapshot above; the activity match (which the lock
    // query didn't filter on) is confirmed separately so a wrong-activity slot
    // still 404s as before.
    const newSlot = lockedSlots.find((s) => s.id === newTimeslotId) ?? null;
    const newSlotMatchesActivity = newSlot
      ? (await tx.timeslot.findFirst({
          where: { id: newTimeslotId, activity_id: item.activity_id },
          select: { id: true },
        })) !== null
      : false;
    if (!newSlot || !newSlotMatchesActivity) {
      throw new BookingError('TIMESLOT_NOT_FOUND', 'That timeslot is not available for this activity', 404);
    }
    if (newSlot.status === 'CANCELLED') {
      throw new BookingError('TIMESLOT_CANCELLED', 'That timeslot has been cancelled', 409);
    }
    // Customers can't self-reschedule onto a slot that has already started.
    if (channel === 'CUSTOMER' && newSlot.datetime.getTime() <= Date.now()) {
      throw new BookingError(
        'TIMESLOT_PAST',
        'That timeslot has already started and can no longer be booked online',
        409,
      );
    }
    const remaining = newSlot.capacity_total - newSlot.capacity_booked;
    if (item.quantity > remaining) {
      throw new BookingError(
        'INSUFFICIENT_CAPACITY',
        remaining <= 0
          ? 'That timeslot is fully booked'
          : `Only ${remaining} spot(s) remain for that timeslot`,
        409,
      );
    }

    // Release the old slot's capacity (defensive floor at 0).
    if (currentSlot) {
      const oldBooked = Math.max(0, currentSlot.capacity_booked - item.quantity);
      await tx.timeslot.update({
        where: { id: currentSlot.id },
        data: {
          capacity_booked: oldBooked,
          status:
            currentSlot.status === 'CANCELLED'
              ? 'CANCELLED'
              : computeSlotStatus(currentSlot.capacity_total, oldBooked),
        },
      });
    }

    // Take capacity on the new slot and repoint the item.
    const newBooked = newSlot.capacity_booked + item.quantity;
    await tx.timeslot.update({
      where: { id: newSlot.id },
      data: { capacity_booked: newBooked, status: computeSlotStatus(newSlot.capacity_total, newBooked) },
    });
    await tx.orderItem.update({ where: { id: item.id }, data: { timeslot_id: newTimeslotId } });

    // --- Move any shared-resource reservations to the new window (re-checking that
    //     the resource is free then, excluding this item's own current hold). ---
    const pools = await activityResourcePools(tx, item.activity_id);
    if (pools.length > 0 && newSlot.datetime) {
      const rateRow = await tx.rate.findFirst({
        where: { id: item.rate_id },
        select: { duration_minutes: true },
      });
      const { startsAt, endsAt } = bookingWindow(newSlot.datetime, rateRow?.duration_minutes ?? 0);
      // Same per-pool serialisation as the create path (reschedule FOR UPDATEs neither
      // slot, so it has the identical oversell hole across windows).
      await lockResourcePools(tx, pools.map((p) => p.id));
      const conflict = await findResourceConflict(tx, {
        pools,
        startsAt,
        endsAt,
        seats: item.quantity,
        excludeOrderItemId: item.id,
      });
      if (conflict) {
        throw new BookingError(
          'INSUFFICIENT_RESOURCE',
          conflict.remaining <= 0
            ? `${conflict.name} is fully booked for that time`
            : `Only ${conflict.remaining} left of ${conflict.name} for that time`,
          409,
        );
      }
      await releaseResourceBookings(tx, [item.id]);
      await writeResourceBookings(tx, {
        operatorId,
        orderItemId: item.id,
        pools,
        seats: item.quantity,
        startsAt,
        endsAt,
      });
    }

    await tx.orderEvent.create({
      data: {
        operator_id: operatorId,
        order_id: order.id,
        type: 'RESCHEDULED',
        description: `Booking ${order.order_number} rescheduled via ${channel.toLowerCase()} channel`,
        actor: options.actor ?? null,
        metadata: {
          orderItemId: item.id,
          fromTimeslotId: currentSlot?.id ?? null,
          toTimeslotId: newTimeslotId,
          quantity: item.quantity,
        } as Prisma.InputJsonValue,
      },
    });

    const result = await tx.order.findFirst({
      where: { id: order.id },
      include: {
        items: { include: { activity: true, rate: true, timeslot: true } },
        customer: true,
      },
    });
    // The slot this booking vacated — its seats are sellable again on commit.
    return { order: result, freedTimeslotId: currentSlot?.id ?? null };
  });

  // Post-commit, fire-and-forget: offer the vacated seats to that slot's
  // waitlist. Never blocks or fails the reschedule (see cancelBooking).
  if (freedTimeslotId) queueWaitlistNotifications(operatorId, [freedTimeslotId]);

  return rescheduled;
}

/** Summary returned after collecting a deposit's remaining balance. */
export interface CollectBalanceResult {
  orderId: string;
  orderNumber: string;
  paymentId: string;
  chargedCents: number;
  amountPaidCents: number;
  balanceDueCents: number;
}

/**
 * Collect the remaining balance on a deposit order (the "pay the rest at check-in"
 * step). Charges the order's outstanding `balance_due_cents` via the (simulated)
 * card processor, records a Payment row, zeroes the balance, and writes a
 * BALANCE_COLLECTED OrderEvent — all inside one tenant transaction so the ledger
 * can never drift. Idempotent-ish: a zero balance is a clean no-op error.
 *
 * Shared by the staff API route and the admin "Collect balance" action. In fake-
 * payments dev mode no external call is made; when payments are not configured at
 * all it throws so the caller returns a clean 501.
 */
export async function collectBalance(
  operatorId: string,
  orderId: string,
  options: { actor?: string; method?: 'CARD' | 'CASH' } = {},
): Promise<CollectBalanceResult> {
  const paymentProvider = await getPaymentProvider(operatorId);
  if (paymentProvider.providerKey === 'none' && (options.method ?? 'CARD') === 'CARD') {
    throw new BookingError('PAYMENTS_NOT_CONFIGURED', 'Payments are not configured', 501);
  }

  return withTenant(operatorId, async (tx) => {
    // Lock the Order row FOR UPDATE before reading the ledger. Without it, a
    // concurrent gift-card redeem (gift-cards.ts) reads the same balance_due,
    // and both writers zero it last-writer-wins — the customer pays twice.
    // The lock serialises the two writers: the loser blocks until this tx
    // commits, then reads the freshly-reduced balance. Held to end-of-tx.
    const lockedOrder = await tx.$queryRaw<
      Array<{
        id: string;
        order_number: string;
        status: string;
        total_cents: number;
        amount_paid_cents: number;
        balance_due_cents: number;
      }>
    >`
      SELECT id, order_number, status, total_cents, amount_paid_cents, balance_due_cents
      FROM "Order"
      WHERE id = ${orderId}
      FOR UPDATE`;
    const order = lockedOrder[0];
    if (!order) {
      throw new BookingError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    if (order.status === 'CANCELLED') {
      throw new BookingError('ORDER_CANCELLED', 'This order has been cancelled', 409);
    }
    const balanceDue = order.balance_due_cents;
    if (balanceDue <= 0) {
      throw new BookingError('NO_BALANCE_DUE', 'This order has no outstanding balance', 400);
    }

    const method = options.method ?? 'CARD';
    let cardBrand: string | null = null;
    let cardLastFour: string | null = null;
    let cardholderName: string | null = null;
    let processorTransactionId: string | null = null;
    if (method === 'CARD') {
      // settledOrThrow: a staff balance-collection has no 3DS answer path either —
      // anything but success throws and the caller reports it (pre-seam behavior).
      const charge = settledOrThrow(
        await paymentProvider.charge({
          orderId: order.id,
          tokenizedSource: 'balance',
          amountCents: balanceDue,
          idempotencyKey: `balance-${order.id}-${order.amount_paid_cents}`,
          operatorId,
        }),
      );
      cardBrand = charge.cardBrand;
      cardLastFour = charge.cardLastFour;
      cardholderName = charge.cardholderName;
      processorTransactionId = charge.paymentRef;
    }

    const payment = await tx.payment.create({
      data: {
        operator_id: operatorId,
        order_id: order.id,
        method,
        status: 'PAID',
        amount_cents: balanceDue,
        card_brand: cardBrand,
        card_last_four: cardLastFour,
        cardholder_name: cardholderName,
        processor: 'STRIPE',
        processor_transaction_id: processorTransactionId,
      },
    });

    const newAmountPaid = order.amount_paid_cents + balanceDue;
    await tx.order.update({
      where: { id: order.id },
      data: { amount_paid_cents: newAmountPaid, balance_due_cents: 0 },
    });

    await tx.orderEvent.create({
      data: {
        operator_id: operatorId,
        order_id: order.id,
        type: 'BALANCE_COLLECTED',
        description: `Balance of ${(balanceDue / 100).toFixed(2)} USD collected at check-in`,
        actor: options.actor ?? null,
        metadata: {
          paymentId: payment.id,
          chargedCents: balanceDue,
          method,
          amountPaidCents: newAmountPaid,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      orderId: order.id,
      orderNumber: order.order_number,
      paymentId: payment.id,
      chargedCents: balanceDue,
      amountPaidCents: newAmountPaid,
      balanceDueCents: 0,
    };
  });
}
