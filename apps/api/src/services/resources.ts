/**
 * Shared-resource capacity — the operational moat over Singenuity/FareHarbor.
 *
 * A Resource is a pool of interchangeable physical units (jet skis, pontoons,
 * kayaks, guides). Its total seats = (quantity - out_of_service_qty) * seat_capacity.
 * Activities link to the resources they draw from (Activity <-> Resource M2M). When a
 * booking is made, it reserves `seats` on each linked resource for the booking's time
 * window [starts_at, ends_at). Because that reservation is checked against EVERY
 * booking overlapping the window — no matter which activity it came through — the same
 * boat can't be sold twice across two different activities at the same time.
 *
 * These helpers are pure data operations that RETURN conflicts rather than throwing,
 * so the booking service owns all user-facing error mapping (and there's no import
 * cycle with booking.ts).
 */
import { Prisma } from '@marina/database';

/** A resource pool an activity draws from, with the numbers needed to size it. */
export interface ResourcePool {
  id: string;
  name: string;
  seat_capacity: number;
  quantity: number;
  out_of_service_qty: number;
}

/** Total bookable seats a pool provides right now (out-of-service units removed). */
export function poolSeats(pool: ResourcePool): number {
  return Math.max(0, pool.quantity - pool.out_of_service_qty) * pool.seat_capacity;
}

/** The active resource pools an activity draws from (empty ⇒ timeslot-only capacity). */
export async function activityResourcePools(
  tx: Prisma.TransactionClient,
  activityId: string,
): Promise<ResourcePool[]> {
  return tx.resource.findMany({
    where: { is_active: true, activities: { some: { id: activityId } } },
    select: { id: true, name: true, seat_capacity: true, quantity: true, out_of_service_qty: true },
  });
}

/** Seats already reserved on a pool by bookings overlapping [startsAt, endsAt). */
export async function reservedSeats(
  tx: Prisma.TransactionClient,
  params: { resourceId: string; startsAt: Date; endsAt: Date; excludeOrderItemId?: string },
): Promise<number> {
  const agg = await tx.resourceBooking.aggregate({
    _sum: { seats: true },
    where: {
      resource_id: params.resourceId,
      // Half-open interval overlap: existing.start < new.end AND existing.end > new.start.
      starts_at: { lt: params.endsAt },
      ends_at: { gt: params.startsAt },
      ...(params.excludeOrderItemId
        ? { order_item_id: { not: params.excludeOrderItemId } }
        : {}),
    },
  });
  return agg._sum.seats ?? 0;
}

/**
 * First resource pool (if any) that can't fit `seats` more in the window. Returns the
 * offending pool's name and how many seats remain so the caller can craft the message,
 * or null when every pool has room (or the activity has no linked resources).
 */
export async function findResourceConflict(
  tx: Prisma.TransactionClient,
  params: {
    pools: ResourcePool[];
    startsAt: Date;
    endsAt: Date;
    seats: number;
    excludeOrderItemId?: string;
  },
): Promise<{ name: string; remaining: number } | null> {
  for (const pool of params.pools) {
    const total = poolSeats(pool);
    const used = await reservedSeats(tx, {
      resourceId: pool.id,
      startsAt: params.startsAt,
      endsAt: params.endsAt,
      excludeOrderItemId: params.excludeOrderItemId,
    });
    const remaining = total - used;
    if (params.seats > remaining) {
      return { name: pool.name, remaining: Math.max(0, remaining) };
    }
  }
  return null;
}

/** Reserve `seats` on each pool for an order item's booking window. */
export async function writeResourceBookings(
  tx: Prisma.TransactionClient,
  params: {
    operatorId: string;
    orderItemId: string;
    pools: ResourcePool[];
    seats: number;
    startsAt: Date;
    endsAt: Date;
  },
): Promise<void> {
  for (const pool of params.pools) {
    await tx.resourceBooking.create({
      data: {
        operator_id: params.operatorId,
        resource_id: pool.id,
        order_item_id: params.orderItemId,
        seats: params.seats,
        starts_at: params.startsAt,
        ends_at: params.endsAt,
      },
    });
  }
}

/** Free every resource reservation held by the given order items (cancel/reschedule). */
export async function releaseResourceBookings(
  tx: Prisma.TransactionClient,
  orderItemIds: string[],
): Promise<void> {
  if (orderItemIds.length === 0) return;
  await tx.resourceBooking.deleteMany({
    where: { order_item_id: { in: orderItemIds } },
  });
}

/** Booking window for a timeslot start + rate duration (ends_at is exclusive). */
export function bookingWindow(startsAt: Date, durationMinutes: number): { startsAt: Date; endsAt: Date } {
  const dur = durationMinutes > 0 ? durationMinutes : 0;
  return { startsAt, endsAt: new Date(startsAt.getTime() + dur * 60_000) };
}
