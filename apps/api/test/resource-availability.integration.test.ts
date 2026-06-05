/**
 * Resource-backed availability — live integration test against the seeded LSRA tenant
 * on Neon. Proves the moat behaviour: a shared physical asset (a `Resource`) that backs
 * TWO activities is a single pool, so a booking on one activity removes capacity from
 * the other for any OVERLAPPING time, even though each activity's own timeslot capacity
 * is untouched.
 *
 * Setup (all disposable, swept in afterAll): one resource `R` with quantity=1,
 * seat_capacity=2 ⇒ a shared pool of 2 seats. Two fresh activities A and B, each with a
 * 60-minute rate, both backed by R. Concurrent timeslots so their windows overlap.
 *
 * Cases:
 *  1. Empty pool: B's slot reports remaining = poolTotal (2), unconstrained = false.
 *  2. Booking 2 seats on A's overlapping slot drains the pool; B now reports remaining 0.
 *  3. createBooking on B is refused (INSUFFICIENT_RESOURCE_CAPACITY) even though B's own
 *     slot has plenty of capacity — the resource is the binding limit.
 *  4. getDayAvailability for B shows the slot resourceConstrained with capacityRemaining 0.
 *  5. A NON-overlapping slot of B (hours later) is unaffected — full pool remains.
 *  6. An activity backed by NO resource is unconstrained (remaining: null).
 *
 * SKIPS when DATABASE_URL is unset so plain `pnpm test` stays green pre-Neon.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { createBooking, BookingError } from '../src/services/booking.js';
import {
  getResourceConstraint,
  getResourceConstraints,
} from '../src/services/resource-availability.js';
import { getDayAvailability } from '../src/services/availability.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'resource-itest@example.com';
const TAG = 'ZZ-RESOURCE-ITEST';

interface Fixture {
  resourceId: string;
  activityA: string;
  activityB: string;
  rateA: string;
  rateB: string;
  /** A and B concurrent slots (same instant) → overlapping windows. */
  slotA: string;
  slotBConcurrent: string;
  /** A B slot hours later → non-overlapping with A's booking. */
  slotBLater: string;
  /** An activity with no resource backing it. */
  activityFree: string;
  rateFree: string;
  slotFree: string;
}

let fx: Fixture;
let bookedOrderId: string | null = null;

/** Create a minimal active, online activity with one 60-min public rate. */
async function makeActivity(name: string): Promise<{ activityId: string; rateId: string }> {
  const activity = await adminPrisma.activity.create({
    data: {
      operator_id: OP,
      name_internal: `${TAG} ${name}`,
      name_external: `${TAG} ${name}`,
      status: 'ACTIVE',
      visible_online: true,
      min_participants: 1,
      max_participants: 20, // big, so the slot's OWN capacity is never the binding limit
    },
    select: { id: true },
  });
  const rate = await adminPrisma.rate.create({
    data: {
      operator_id: OP,
      activity_id: activity.id,
      name_internal: `${TAG} ${name} rate`,
      name_external: `${TAG} ${name} rate`,
      price_cents: 5000,
      duration_minutes: 60,
      is_active: true,
      internal_only: false,
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
      capacity_total: 20,
      capacity_booked: 0,
      status: 'AVAILABLE',
    },
    select: { id: true },
  });
  return slot.id;
}

describe.skipIf(!HAS_DB)('resource-backed availability (live vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    const a = await makeActivity('A');
    const b = await makeActivity('B');
    const free = await makeActivity('FREE');

    // A shared resource: 1 unit × 2 seats = a pool of 2 seats, backing A and B (not FREE).
    const resource = await adminPrisma.resource.create({
      data: {
        operator_id: OP,
        name: `${TAG} SharedBoat`,
        seat_capacity: 2,
        quantity: 1,
        out_of_service_qty: 0,
        is_active: true,
        activities: { connect: [{ id: a.activityId }, { id: b.activityId }] },
      },
      select: { id: true },
    });

    const base = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000); // ~40 days out
    // 18:00 UTC maps to mid-morning/early-afternoon in any US zone, so the slot's UTC
    // calendar day equals its operator-timezone day (keeps the day-availability lookup
    // deterministic regardless of the operator's tz).
    base.setUTCHours(18, 0, 0, 0);
    const later = new Date(base.getTime() + 5 * 60 * 60 * 1000); // +5h, no overlap with a 60-min window

    fx = {
      resourceId: resource.id,
      activityA: a.activityId,
      activityB: b.activityId,
      rateA: a.rateId,
      rateB: b.rateId,
      activityFree: free.activityId,
      rateFree: free.rateId,
      slotA: await makeSlot(a.activityId, base),
      slotBConcurrent: await makeSlot(b.activityId, base),
      slotBLater: await makeSlot(b.activityId, later),
      slotFree: await makeSlot(free.activityId, base),
    };
  });

  afterAll(async () => {
    if (bookedOrderId) await adminPrisma.order.deleteMany({ where: { id: bookedOrderId } });
    // Orders referencing the slots must go before the slots (composite FK).
    const slotIds = [fx.slotA, fx.slotBConcurrent, fx.slotBLater, fx.slotFree].filter(Boolean);
    const items = await adminPrisma.orderItem.findMany({
      where: { timeslot_id: { in: slotIds } },
      select: { order_id: true },
    });
    const orderIds = [...new Set(items.map((i) => i.order_id))];
    if (orderIds.length) await adminPrisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await adminPrisma.timeslot.deleteMany({ where: { id: { in: slotIds } } });
    await adminPrisma.rate.deleteMany({ where: { operator_id: OP, name_internal: { startsWith: TAG } } });
    await adminPrisma.resource.deleteMany({ where: { id: fx.resourceId } });
    await adminPrisma.activity.deleteMany({ where: { operator_id: OP, name_internal: { startsWith: TAG } } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('reports the full shared pool when nothing is booked', async () => {
    const db = forOperator(OP);
    const slot = await adminPrisma.timeslot.findUnique({ where: { id: fx.slotBConcurrent } });
    const c = await getResourceConstraint(db, {
      activityId: fx.activityB,
      slotStart: slot!.datetime,
      durationMs: 60 * 60_000,
    });
    expect(c.remaining).toBe(2); // seat_capacity 2 × qty 1
    expect(c.bindingResourceName).toContain('SharedBoat');
  });

  it('an unbacked activity is unconstrained (remaining null)', async () => {
    const db = forOperator(OP);
    const slot = await adminPrisma.timeslot.findUnique({ where: { id: fx.slotFree } });
    const c = await getResourceConstraint(db, {
      activityId: fx.activityFree,
      slotStart: slot!.datetime,
      durationMs: 60 * 60_000,
    });
    expect(c.remaining).toBeNull();
  });

  it('a booking on activity A drains the shared pool for the OVERLAPPING B slot', async () => {
    // Book 2 seats on A at the concurrent time → pool fully committed.
    const order = await createBooking(
      OP,
      {
        activityId: fx.activityA,
        rateId: fx.rateA,
        timeslotId: fx.slotA,
        quantity: 2,
        customer: { first_name: 'Res', last_name: 'Itest', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'STAFF', actor: 'resource.integration.test' },
    );
    bookedOrderId = order.id;

    const db = forOperator(OP);
    const concurrent = await adminPrisma.timeslot.findUnique({ where: { id: fx.slotBConcurrent } });
    const cNow = await getResourceConstraint(db, {
      activityId: fx.activityB,
      slotStart: concurrent!.datetime,
      durationMs: 60 * 60_000,
    });
    expect(cNow.remaining).toBe(0); // pool drained by A's overlapping booking

    // A NON-overlapping B slot 5 hours later is untouched.
    const later = await adminPrisma.timeslot.findUnique({ where: { id: fx.slotBLater } });
    const cLater = await getResourceConstraint(db, {
      activityId: fx.activityB,
      slotStart: later!.datetime,
      durationMs: 60 * 60_000,
    });
    expect(cLater.remaining).toBe(2);
  });

  it('refuses a booking on B when the shared resource is fully committed', async () => {
    // B's own slot has 20 capacity free, so the only thing that can stop this is the pool.
    await expect(
      createBooking(
        OP,
        {
          activityId: fx.activityB,
          rateId: fx.rateB,
          timeslotId: fx.slotBConcurrent,
          quantity: 1,
          customer: { first_name: 'Blocked', last_name: 'Itest', email: TEST_EMAIL },
          participants: [],
        },
        { channel: 'STAFF' },
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_RESOURCE_CAPACITY' });

    // The B slot's own capacity must be untouched by the refused attempt.
    const slot = await adminPrisma.timeslot.findUnique({ where: { id: fx.slotBConcurrent } });
    expect(slot!.capacity_booked).toBe(0);
  });

  it('getDayAvailability surfaces the slot as resource-constrained with 0 remaining', async () => {
    const db = forOperator(OP);
    const concurrent = await adminPrisma.timeslot.findUnique({ where: { id: fx.slotBConcurrent } });
    const date = concurrent!.datetime.toISOString().slice(0, 10);

    const day = await getDayAvailability(db, { activityId: fx.activityB, date });
    const view = day.timeslots.find((t) => t.id === fx.slotBConcurrent);
    expect(view).toBeDefined();
    expect(view!.resourceConstrained).toBe(true);
    expect(view!.capacityRemaining).toBe(0);
    expect(view!.status).toBe('FULL');
    expect(view!.capacityTotal).toBe(20); // own capacity unchanged, only the effective view shifts
  });

  it('batched getResourceConstraints keys results by slot id', async () => {
    const db = forOperator(OP);
    const concurrent = await adminPrisma.timeslot.findUnique({ where: { id: fx.slotBConcurrent } });
    const later = await adminPrisma.timeslot.findUnique({ where: { id: fx.slotBLater } });
    const map = await getResourceConstraints(
      db,
      fx.activityB,
      [
        { id: concurrent!.id, datetime: concurrent!.datetime },
        { id: later!.id, datetime: later!.datetime },
      ],
      60 * 60_000,
    );
    expect(map.get(concurrent!.id)?.remaining).toBe(0);
    expect(map.get(later!.id)?.remaining).toBe(2);
  });
});
