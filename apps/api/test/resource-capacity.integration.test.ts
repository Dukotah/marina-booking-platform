/**
 * Shared-resource capacity — the operational moat over Singenuity/FareHarbor.
 *
 * Proves, live against the LSRA tenant, that a resource pool shared by TWO
 * activities is enforced ACROSS them: booking activity A draws down the shared
 * pool so an OVERLAPPING booking on activity B is refused once the pool is
 * exhausted — even though B's own timeslot still has room. Also proves a
 * non-overlapping window on B is fine, and that cancelling A frees the pool.
 *
 * Everything is disposable (its own resource, two activities, rates, timeslots,
 * customer) and torn down in afterAll, so it never pollutes the seed and is safe
 * to re-run. SKIPS without DATABASE_URL so plain `pnpm test` stays green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { createBooking, cancelBooking, BookingError } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'resource-itest@example.com';
const DURATION_MIN = 60;

interface Fx {
  resourceId: string;
  activityA: string;
  activityB: string;
  rateA: string;
  rateB: string;
  slotA: string; // A @ window W
  slotBOverlap: string; // B @ window W (overlaps A)
  slotBApart: string; // B @ W + 2h (no overlap)
}

let fx: Fx;
const createdOrderIds: string[] = [];

async function makeActivity(name: string): Promise<{ activityId: string; rateId: string }> {
  const activity = await adminPrisma.activity.create({
    data: {
      operator_id: OP,
      name_internal: name,
      name_external: name,
      status: 'ACTIVE',
      visible_online: true,
      min_participants: 1,
      max_participants: 10,
    },
    select: { id: true },
  });
  const rate = await adminPrisma.rate.create({
    data: {
      operator_id: OP,
      activity_id: activity.id,
      name_internal: 'Hour',
      name_external: 'Hour',
      price_cents: 5000,
      duration_minutes: DURATION_MIN,
      is_active: true,
    },
    select: { id: true },
  });
  return { activityId: activity.id, rateId: rate.id };
}

async function makeSlot(activityId: string, at: Date): Promise<string> {
  const slot = await adminPrisma.timeslot.create({
    data: {
      operator_id: OP,
      activity_id: activityId,
      datetime: at,
      capacity_total: 10, // generous: the RESOURCE, not the timeslot, is the limiter
      capacity_booked: 0,
      status: 'AVAILABLE',
    },
    select: { id: true },
  });
  return slot.id;
}

function book(activityId: string, rateId: string, timeslotId: string, qty: number) {
  return createBooking(
    OP,
    {
      activityId,
      rateId,
      timeslotId,
      quantity: qty,
      customer: { first_name: 'Res', last_name: 'Itest', email: TEST_EMAIL },
      participants: [],
    },
    { channel: 'CUSTOMER', actor: 'resource-capacity.integration.test' },
  );
}

describe.skipIf(!HAS_DB)('shared-resource capacity (live vs LSRA)', () => {
  beforeAll(async () => {
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    const a = await makeActivity('ITEST Shared A');
    const b = await makeActivity('ITEST Shared B');

    // One pool of 2 interchangeable units (1 seat each) shared by BOTH activities.
    const resource = await adminPrisma.resource.create({
      data: {
        operator_id: OP,
        name: 'ITEST Shared Jet Skis',
        seat_capacity: 1,
        quantity: 2,
        out_of_service_qty: 0,
        is_active: true,
        activities: { connect: [{ id: a.activityId }, { id: b.activityId }] },
      },
      select: { id: true },
    });

    const w = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000); // ~40 days out
    const apart = new Date(w.getTime() + 2 * 60 * 60 * 1000); // +2h, past A's 60-min window

    fx = {
      resourceId: resource.id,
      activityA: a.activityId,
      activityB: b.activityId,
      rateA: a.rateId,
      rateB: b.rateId,
      slotA: await makeSlot(a.activityId, w),
      slotBOverlap: await makeSlot(b.activityId, w),
      slotBApart: await makeSlot(b.activityId, apart),
    };
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await adminPrisma.order.deleteMany({ where: { id } }); // cascades items → resource bookings
    }
    if (fx) {
      await adminPrisma.resource.deleteMany({ where: { id: fx.resourceId } });
      await adminPrisma.timeslot.deleteMany({
        where: { id: { in: [fx.slotA, fx.slotBOverlap, fx.slotBApart] } },
      });
      await adminPrisma.rate.deleteMany({ where: { id: { in: [fx.rateA, fx.rateB] } } });
      await adminPrisma.activity.deleteMany({ where: { id: { in: [fx.activityA, fx.activityB] } } });
    }
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('books activity A and reserves the full shared pool for its window', async () => {
    const order = await book(fx.activityA, fx.rateA, fx.slotA, 2); // takes both units
    createdOrderIds.push(order.id);

    const reservations = await adminPrisma.resourceBooking.findMany({
      where: { resource_id: fx.resourceId },
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.seats).toBe(2);
  });

  it('refuses an OVERLAPPING booking on activity B — the shared boat is taken', async () => {
    await expect(book(fx.activityB, fx.rateB, fx.slotBOverlap, 1)).rejects.toMatchObject({
      code: 'INSUFFICIENT_RESOURCE',
    });
    // And it must be a typed BookingError (409), not a generic throw.
    await expect(book(fx.activityB, fx.rateB, fx.slotBOverlap, 1)).rejects.toBeInstanceOf(BookingError);
  });

  it('allows a NON-overlapping window on activity B — same pool, different time', async () => {
    const order = await book(fx.activityB, fx.rateB, fx.slotBApart, 2);
    createdOrderIds.push(order.id);
    const count = await adminPrisma.resourceBooking.count({ where: { resource_id: fx.resourceId } });
    expect(count).toBe(2); // A's + this one
  });

  it('frees the pool when A is cancelled, letting B book the overlapping window', async () => {
    // Cancel A's order (the first one created).
    await cancelBooking(OP, createdOrderIds[0]!, { actor: 'resource-capacity.integration.test' });

    // A's reservation is gone; the overlapping B booking now succeeds.
    const order = await book(fx.activityB, fx.rateB, fx.slotBOverlap, 2);
    createdOrderIds.push(order.id);

    const reservations = await adminPrisma.resourceBooking.findMany({
      where: { resource_id: fx.resourceId, order_item_id: { not: undefined } },
    });
    // A(cancelled, released) gone; B-apart (2) + B-overlap (2) remain.
    expect(reservations.reduce((n, r) => n + r.seats, 0)).toBe(4);
  });
});
