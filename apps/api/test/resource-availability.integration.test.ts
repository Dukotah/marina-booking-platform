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
import { createBooking, rescheduleBooking } from '../src/services/booking.js';
import {
  getResourceConstraint,
  getResourceConstraints,
} from '../src/services/resource-availability.js';
import { getDayAvailability, getRangeAvailability } from '../src/services/availability.js';
import { app } from '../src/app.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
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
let createdStaff = false;

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

    // Ensure the dev-owner staff principal the POS HTTP test authenticates as exists
    // (the dev auth shim resolves x-dev-staff-id → this row). Track if we created it.
    const existingStaff = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!existingStaff) {
      const loc = await adminPrisma.location.findFirst({ where: { operator_id: OP }, select: { id: true } });
      await adminPrisma.staffMember.create({
        data: {
          operator_id: OP,
          auth_user_id: 'dev-owner',
          name: 'Dev Owner',
          email: 'dev-owner@example.com',
          role: 'OWNER',
          is_active: true,
          locations: loc ? { create: { location_id: loc.id } } : undefined,
        },
      });
      createdStaff = true;
    }

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
    // +26h → the NEXT calendar day, so (a) no time-overlap with A's 60-min window and
    // (b) the reschedule's B booking lands on a different service date than A's booking,
    // sidestepping the createBooking per-service-day order-number sequencing.
    const later = new Date(base.getTime() + 26 * 60 * 60 * 1000);

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
    // TAG-driven sweep: clean every slot/order under any TAG activity (covers slots
    // created by individual tests, not just the fixed fixture set), in FK-safe order.
    const tagActivities = await adminPrisma.activity.findMany({
      where: { operator_id: OP, name_internal: { startsWith: TAG } },
      select: { id: true },
    });
    const tagActivityIds = tagActivities.map((a) => a.id);
    const tagSlots = await adminPrisma.timeslot.findMany({
      where: { activity_id: { in: tagActivityIds } },
      select: { id: true },
    });
    const slotIds = tagSlots.map((s) => s.id);
    const items = await adminPrisma.orderItem.findMany({
      where: { timeslot_id: { in: slotIds } },
      select: { order_id: true },
    });
    const orderIds = [...new Set(items.map((i) => i.order_id))];
    if (orderIds.length) await adminPrisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await adminPrisma.timeslot.deleteMany({ where: { id: { in: slotIds } } });
    await adminPrisma.rate.deleteMany({ where: { operator_id: OP, name_internal: { startsWith: TAG } } });
    await adminPrisma.resource.deleteMany({ where: { operator_id: OP, name: { startsWith: TAG } } });
    await adminPrisma.activity.deleteMany({ where: { operator_id: OP, name_internal: { startsWith: TAG } } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
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

  it('POS sale on B is refused when the shared resource is fully committed', async () => {
    const res = await app.request('/api/pos/sale', {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner', 'content-type': 'application/json' },
      body: JSON.stringify({
        lines: [
          { kind: 'BOOKING', activityId: fx.activityB, rateId: fx.rateB, timeslotId: fx.slotBConcurrent, quantity: 1 },
        ],
        payment: { method: 'CASH', amountCents: 100_000 },
        customer: { email: TEST_EMAIL, first_name: 'POS', last_name: 'Blocked' },
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? '').toMatch(/committed|remain/i);

    // The refused sale must not have moved the slot's capacity.
    const slot = await adminPrisma.timeslot.findUnique({ where: { id: fx.slotBConcurrent } });
    expect(slot!.capacity_booked).toBe(0);
  });

  it('reschedule into the committed window is refused (move into a free window allowed)', async () => {
    // A B booking in the FREE later window (pool open there).
    const order = await createBooking(
      OP,
      {
        activityId: fx.activityB,
        rateId: fx.rateB,
        timeslotId: fx.slotBLater,
        quantity: 1,
        customer: { first_name: 'Resched', last_name: 'Itest', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'STAFF' },
    );

    // Moving it onto the concurrent slot (A has committed the pool there) is refused —
    // and the item must stay put on its original slot.
    await expect(
      rescheduleBooking(OP, order.id, fx.slotBConcurrent, { channel: 'STAFF' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_RESOURCE_CAPACITY' });

    const item = await adminPrisma.orderItem.findFirst({ where: { order_id: order.id } });
    expect(item!.timeslot_id).toBe(fx.slotBLater);
  });

  it('month-range rollup marks a fully resource-committed day red (own seats still open)', async () => {
    const db = forOperator(OP);
    const concurrent = await adminPrisma.timeslot.findUnique({ where: { id: fx.slotBConcurrent } });
    const date = concurrent!.datetime.toISOString().slice(0, 10);

    const range = await getRangeAvailability(db, { activityId: fx.activityB, from: date, to: date });
    const day = range.days.find((d) => d.date === date);
    expect(day).toBeDefined();
    // B's only slot that day has 20 of its own seats free, but A has committed the shared
    // pool → the calendar day must read red with nothing effectively bookable.
    expect(day!.capacityTotal).toBe(20);
    expect(day!.capacityRemaining).toBe(0);
    expect(day!.signal).toBe('red');
  });

  it('WHOLE_UNIT (charter): one booking reserves the whole unit regardless of party size', async () => {
    // A fresh activity backed by a 1-unit, 10-seat WHOLE_UNIT resource (a chartered boat).
    const c = await makeActivity('CHARTER');
    const resource = await adminPrisma.resource.create({
      data: {
        operator_id: OP,
        name: `${TAG} CharterBoat`,
        seat_capacity: 10,
        quantity: 1,
        out_of_service_qty: 0,
        allocation_mode: 'WHOLE_UNIT',
        is_active: true,
        activities: { connect: [{ id: c.activityId }] },
      },
      select: { id: true },
    });
    const at = new Date(Date.now() + 42 * 24 * 60 * 60 * 1000);
    at.setUTCHours(18, 0, 0, 0);
    const slot = await forOperator(OP).timeslot.create({
      data: { operator_id: OP, activity_id: c.activityId, datetime: at, capacity_total: 10, capacity_booked: 0, status: 'AVAILABLE' },
      select: { id: true },
    });

    const db = forOperator(OP);
    // Empty: the whole unit is available → remaining == the unit's seat_capacity (10).
    const before = await getResourceConstraint(db, { activityId: c.activityId, slotStart: at, durationMs: 60 * 60_000 });
    expect(before.remaining).toBe(10);

    // Book just 2 of 10 seats. In a shared model 8 would remain; as a WHOLE_UNIT charter
    // the single unit is now taken, so the resource is fully committed.
    const order = await createBooking(
      OP,
      {
        activityId: c.activityId,
        rateId: c.rateId,
        timeslotId: slot.id,
        quantity: 2,
        customer: { first_name: 'Charter', last_name: 'Itest', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'STAFF' },
    );
    expect(order.id).toBeTruthy();

    const after = await getResourceConstraint(db, { activityId: c.activityId, slotStart: at, durationMs: 60 * 60_000 });
    expect(after.remaining).toBe(0); // whole unit consumed by one booking, 8 seats notwithstanding

    // A second booking on the same slot is refused — the charter unit is taken.
    await expect(
      createBooking(
        OP,
        {
          activityId: c.activityId,
          rateId: c.rateId,
          timeslotId: slot.id,
          quantity: 1,
          customer: { first_name: 'Charter2', last_name: 'Itest', email: TEST_EMAIL },
          participants: [],
        },
        { channel: 'STAFF' },
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_RESOURCE_CAPACITY' });
  });
});
