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
  calculatePricing,
  computeSlotStatus,
  generateOrderNumber,
  type BookingInput,
  type PricingFee,
  type PricingPromo,
} from '@marina/core';
import { withTenant } from '@marina/database';
import { getResourceConstraint } from './resource-availability.js';

/** How an order entered the system (mirrors Prisma `OrderChannel`). */
export type BookingChannel = 'CUSTOMER' | 'STAFF' | 'KIOSK';

export interface CreateBookingOptions {
  /** Channel the booking came through. Defaults to CUSTOMER (public web). */
  channel?: BookingChannel;
  /** Audit actor for the OrderEvent (e.g. a staff member's id/email). */
  actor?: string;
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

/**
 * Create a booking for the given operator. Returns the persisted Order with its
 * items, customer, and timeslot/activity context needed by the API response.
 */
export async function createBooking(
  operatorId: string,
  input: BookingInput,
  options: CreateBookingOptions = {},
) {
  const channel: BookingChannel = options.channel ?? 'CUSTOMER';

  return withTenant(operatorId, async (tx) => {
    // --- Load + validate the operator (needed for the human order number). ---
    const operator = await tx.operator.findFirst({
      where: { id: operatorId },
      select: { id: true, location_code: true, is_active: true },
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
      select: { id: true, price_cents: true, is_active: true, internal_only: true, duration_minutes: true },
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

    // --- Shared-resource capacity: a backing asset (boat/equipment) may be consumed by
    // a concurrent booking on a SIBLING activity, so the slot's own capacity isn't the
    // whole story. Refuse if no pool unit remains across the overlapping window. A `null`
    // remaining means the activity is backed by no active resource (no extra constraint).
    const resource = await getResourceConstraint(tx, {
      activityId: activity.id,
      slotStart: timeslot.datetime,
      durationMs: rate.duration_minutes * 60_000,
    });
    if (resource.remaining !== null && input.quantity > resource.remaining) {
      const what = resource.bindingResourceName ?? 'the required resource';
      throw new BookingError(
        'INSUFFICIENT_RESOURCE_CAPACITY',
        resource.remaining <= 0
          ? `${what} is fully committed at this time`
          : `Only ${resource.remaining} ${what} spot(s) remain at this time`,
        409,
      );
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

    const pricing = calculatePricing({
      items: [{ unitPriceCents: rate.price_cents, quantity: input.quantity }],
      fees,
      promo,
      tipCents: input.tipCents ?? 0,
    });

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

    // --- Generate a per-location, per-day sequential order number. ---
    const slotDate = timeslot.datetime;
    const dayStart = new Date(slotDate.getFullYear(), slotDate.getMonth(), slotDate.getDate(), 0, 0, 0, 0);
    const dayEnd = new Date(slotDate.getFullYear(), slotDate.getMonth(), slotDate.getDate() + 1, 0, 0, 0, 0);
    const seq =
      (await tx.order.count({
        where: { created_at: { gte: dayStart, lt: dayEnd } },
      })) + 1;
    const orderNumber = generateOrderNumber(operator.location_code, slotDate, seq);

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
        amount_paid_cents: 0,
        balance_due_cents: pricing.totalCents,
        promo_code_id: promoCodeId,
        is_returning_guest: isReturningGuest,
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
              unit_price_cents: rate.price_cents,
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
      include: {
        items: { include: { activity: true, rate: true, timeslot: true } },
        customer: true,
      },
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

    // --- Bump promo redemption count when one was applied. ---
    if (promoCodeId) {
      await tx.promoCode.update({
        where: { id: promoCodeId },
        data: { times_redeemed: { increment: 1 } },
      });
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

    // Shared-resource capacity at the NEW time (D-024). Exclude THIS item so its own
    // current booking can't block a move into an overlapping window; the booked rate's
    // duration sizes the occupancy window.
    const itemRate = await tx.rate.findFirst({
      where: { id: item.rate_id },
      select: { duration_minutes: true },
    });
    const resource = await getResourceConstraint(tx, {
      activityId: item.activity_id,
      slotStart: newSlot.datetime,
      durationMs: (itemRate?.duration_minutes ?? 240) * 60_000,
      excludeOrderItemId: item.id,
    });
    if (resource.remaining !== null && item.quantity > resource.remaining) {
      const what = resource.bindingResourceName ?? 'the required resource';
      throw new BookingError(
        'INSUFFICIENT_RESOURCE_CAPACITY',
        resource.remaining <= 0
          ? `${what} is fully committed at that time`
          : `Only ${resource.remaining} ${what} spot(s) remain at that time`,
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
