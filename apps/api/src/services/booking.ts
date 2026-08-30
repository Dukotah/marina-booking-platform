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
  generateOrderNumber,
  resolveDepositPercent,
  type BookingInput,
  type PricingFee,
  type PricingPromo,
} from '@marina/core';
import { withTenant } from '@marina/database';
import { createPayment, arePaymentsEnabled } from './stripe.js';
import { reconcileSlotPrice } from './pricing-rules.js';
import {
  activityResourcePools,
  bookingWindow,
  findResourceConflict,
  releaseResourceBookings,
  writeResourceBookings,
} from './resources.js';
import { bestActiveMemberPricing, consumeMembershipUses } from './memberships.js';

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
      },
    });
    if (!activity) {
      throw new BookingError('ACTIVITY_NOT_FOUND', 'Activity not found', 404);
    }
    if (activity.status !== 'ACTIVE') {
      throw new BookingError('ACTIVITY_UNAVAILABLE', 'This activity is not available for booking', 409);
    }
    if (
      input.quantity < activity.min_participants ||
      input.quantity > activity.max_participants
    ) {
      throw new BookingError(
        'INVALID_QUANTITY',
        `Quantity must be between ${activity.min_participants} and ${activity.max_participants}`,
      );
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
    // Customers may only book public rates; staff/kiosk may use internal-only rates.
    if (rate.internal_only && channel === 'CUSTOMER') {
      throw new BookingError('RATE_UNAVAILABLE', 'This rate is not available online', 409);
    }

    // --- Load + lock-check the timeslot capacity. ---
    const timeslot = await tx.timeslot.findFirst({
      where: { id: input.timeslotId, activity_id: activity.id },
      select: {
        id: true,
        datetime: true,
        capacity_total: true,
        capacity_booked: true,
        status: true,
      },
    });
    if (!timeslot) {
      throw new BookingError('TIMESLOT_NOT_FOUND', 'Timeslot not found for this activity', 404);
    }
    if (timeslot.status === 'CANCELLED') {
      throw new BookingError('TIMESLOT_CANCELLED', 'This timeslot has been cancelled', 409);
    }
    const remaining = timeslot.capacity_total - timeslot.capacity_booked;
    if (input.quantity > remaining) {
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
      const conflict = await findResourceConflict(tx, {
        pools,
        startsAt,
        endsAt,
        seats: input.quantity,
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
      select: { name: true, type: true, value: true },
    });
    const fees: PricingFee[] = feeRows.map((f) => ({
      name: f.name,
      type: f.type,
      value: f.value,
    }));

    // --- Resolve + validate any promo code against the DB (server-side). ---
    let promo: PricingPromo | null = null;
    let promoCodeId: string | null = null;
    if (input.promoCode) {
      const code = input.promoCode.trim().toUpperCase();
      const promoRow = await tx.promoCode.findFirst({
        where: { code, is_active: true },
        select: {
          id: true,
          discount_type: true,
          discount_value: true,
          valid_from: true,
          valid_until: true,
          max_redemptions: true,
          times_redeemed: true,
          activity_ids: true,
        },
      });
      const now = new Date();
      const isValid =
        promoRow != null &&
        (promoRow.valid_from === null || promoRow.valid_from <= now) &&
        (promoRow.valid_until === null || promoRow.valid_until >= now) &&
        (promoRow.max_redemptions === null ||
          promoRow.times_redeemed < promoRow.max_redemptions) &&
        (promoRow.activity_ids.length === 0 ||
          promoRow.activity_ids.includes(activity.id));
      if (!promoRow || !isValid) {
        throw new BookingError('INVALID_PROMO', 'Promo code is invalid or expired');
      }
      promo = {
        discountType: promoRow.discount_type,
        discountValue: promoRow.discount_value,
      };
      promoCodeId = promoRow.id;
    }

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
      quantity: input.quantity,
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

    // --- Final server-authoritative pricing from the effective unit price + DB fees. ---
    const pricing = calculatePricing({
      items: [{ unitPriceCents, quantity: input.quantity }],
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
    const takeDeposit = depositCents > 0 && depositCents < pricing.totalCents;

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
            {
              activity_id: activity.id,
              rate_id: rate.id,
              timeslot_id: timeslot.id,
              quantity: input.quantity,
              // Effective per-unit price: base -> dynamic pricing rules -> member discount.
              unit_price_cents: unitPriceCents,
              status: 'UPCOMING',
              driver_name: input.participants[0]?.driver_name ?? null,
              license_number: input.participants[0]?.license ?? null,
              date_of_birth: input.participants[0]?.dob
                ? new Date(input.participants[0].dob)
                : null,
            },
          ],
        },
      },
      include: BOOKING_ORDER_INCLUDE,
    });

    // --- Increment timeslot capacity + recompute its display status. ---
    const newBooked = timeslot.capacity_booked + input.quantity;
    await tx.timeslot.update({
      where: { id: timeslot.id },
      data: {
        capacity_booked: newBooked,
        status: computeSlotStatus(timeslot.capacity_total, newBooked),
      },
    });

    // --- Reserve the shared resources this booking consumes for its window. ---
    if (pools.length > 0) {
      await writeResourceBookings(tx, {
        operatorId,
        orderItemId: order.items[0]!.id,
        pools,
        seats: input.quantity,
        startsAt,
        endsAt,
      });
    }

    // --- Bump promo redemption count when one was applied. ---
    if (promoCodeId) {
      await tx.promoCode.update({
        where: { id: promoCodeId },
        data: { times_redeemed: { increment: 1 } },
      });
    }

    // --- Punch-card memberships: spend one use per seat booked. No-op for
    //     unlimited passes / member-rate tiers (null remaining_uses). Depletes the
    //     holding when it hits zero so it stops granting member pricing. ---
    if (member && member.kind === 'PUNCH_CARD') {
      await consumeMembershipUses(tx, member.customerMembershipId, input.quantity);
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
          quantity: input.quantity,
          totalCents: pricing.totalCents,
          timeslotId: timeslot.id,
        } as Prisma.InputJsonValue,
      },
    });

    // --- Deposit charge: when a deposit applies, record the (simulated) card
    //     charge for the deposit amount and audit it. The order's amount_paid /
    //     balance_due were already set to the deposit split above; this writes the
    //     matching Payment ledger row so the two never drift. In fake-payments dev
    //     mode this never touches Stripe; when payments aren't configured at all we
    //     still split the ledger but skip the Payment row (no processor to charge). ---
    if (takeDeposit && arePaymentsEnabled()) {
      // Derived from the order id, so it is stable across a retry of this order and
      // distinct from every other order's deposit. A replayed submit never reaches
      // here at all (the order insert above loses the race first), so this guards
      // the narrower case of a crash between "processor accepted" and "row written".
      const depositKey = `deposit-${order.id}`;
      const charge = await createPayment({
        orderId: order.id,
        sourceId: 'deposit',
        amountCents: depositCents,
        idempotencyKey: depositKey,
        // We are inside the transaction that created this order, so the simulator
        // cannot look the tenant up yet — hand it over.
        operatorId,
      });
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
          processor_transaction_id: charge.paymentId,
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
 * Cancel an order: marks it (and its items) CANCELLED, restores the capacity it
 * held on each timeslot, and records an OrderEvent. Idempotent guard prevents
 * double-restoring capacity for an already-cancelled order. Runs in a tenant
 * transaction so RLS scopes every write.
 */
export async function cancelBooking(
  operatorId: string,
  orderId: string,
  options: { actor?: string; reason?: string } = {},
) {
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

    const updated = await tx.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED' },
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
        metadata: { reason: options.reason ?? null } as Prisma.InputJsonValue,
      },
    });

    return updated;
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

  return withTenant(operatorId, async (tx) => {
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

    // Current slot + the activity's self-reschedule policy window.
    const currentSlot = await tx.timeslot.findFirst({
      where: { id: item.timeslot_id },
      select: { id: true, datetime: true, capacity_total: true, capacity_booked: true, status: true },
    });
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
    const newSlot = await tx.timeslot.findFirst({
      where: { id: newTimeslotId, activity_id: item.activity_id },
      select: { id: true, datetime: true, capacity_total: true, capacity_booked: true, status: true },
    });
    if (!newSlot) {
      throw new BookingError('TIMESLOT_NOT_FOUND', 'That timeslot is not available for this activity', 404);
    }
    if (newSlot.status === 'CANCELLED') {
      throw new BookingError('TIMESLOT_CANCELLED', 'That timeslot has been cancelled', 409);
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

    return tx.order.findFirst({
      where: { id: order.id },
      include: {
        items: { include: { activity: true, rate: true, timeslot: true } },
        customer: true,
      },
    });
  });
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
  if (!arePaymentsEnabled() && (options.method ?? 'CARD') === 'CARD') {
    throw new BookingError('PAYMENTS_NOT_CONFIGURED', 'Payments are not configured', 501);
  }

  return withTenant(operatorId, async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId },
      select: {
        id: true,
        order_number: true,
        status: true,
        total_cents: true,
        amount_paid_cents: true,
        balance_due_cents: true,
      },
    });
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
      const charge = await createPayment({
        orderId: order.id,
        sourceId: 'balance',
        amountCents: balanceDue,
        idempotencyKey: `balance-${order.id}-${order.amount_paid_cents}`,
        operatorId,
      });
      cardBrand = charge.cardBrand;
      cardLastFour = charge.cardLastFour;
      cardholderName = charge.cardholderName;
      processorTransactionId = charge.paymentId;
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
