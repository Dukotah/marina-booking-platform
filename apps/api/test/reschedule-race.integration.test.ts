/**
 * Reschedule overbooking TOCTOU regression — live integration test against the
 * seeded Lake Sonoma (LSRA) tenant. Books two separate source slots, then fires
 * two reschedules in parallel onto ONE shared destination slot that has room for
 * exactly ONE seat, proving the `SELECT ... FOR UPDATE` on BOTH slots in
 * rescheduleBooking serialises them: exactly one move commits, the other fails
 * INSUFFICIENT_CAPACITY, and the destination ends with capacity_booked == 1
 * (never 2 seats on a 1-capacity slot).
 *
 * Without the lock both transactions read the destination's capacity_booked = 0
 * under READ COMMITTED, both pass the app-code capacity check, and both write
 * old+qty — overbooking the destination (and the stale old-slot releases can
 * drift the source counters too).
 *
 * SKIPS when DATABASE_URL is unset. Creates its own disposable slots and a unique
 * customer per booker, and deletes everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { createBooking, rescheduleBooking, BookingError } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const EMAIL_A = 'resched-race-a-itest@example.com';
const EMAIL_B = 'resched-race-b-itest@example.com';
const DAY = 24 * 60 * 60 * 1000;

let activityId = '';
let rateId = '';
let srcA = '';
let srcB = '';
let dest = '';
let orderIdA = '';
let orderIdB = '';

async function purgeTestData(): Promise<void> {
  const custs = await adminPrisma.customer.findMany({
    where: { operator_id: OP, email: { in: [EMAIL_A, EMAIL_B] } },
    select: { id: true },
  });
  const ids = custs.map((c) => c.id);
  if (ids.length) {
    const orders = await adminPrisma.order.findMany({
      where: { operator_id: OP, customer_id: { in: ids } },
      select: { id: true },
    });
    await adminPrisma.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
    await adminPrisma.customer.deleteMany({ where: { id: { in: ids } } });
  }
}

async function makeSlot(offsetMs: number, capTotal: number, capBooked = 0): Promise<string> {
  const slot = await forOperator(OP).timeslot.create({
    data: {
      operator_id: OP,
      activity_id: activityId,
      datetime: new Date(Date.now() + offsetMs),
      capacity_total: capTotal,
      capacity_booked: capBooked,
      status: capBooked >= capTotal ? 'FULL' : 'AVAILABLE',
    },
    select: { id: true },
  });
  return slot.id;
}

describe.skipIf(!HAS_DB)('reschedule overbooking race (live vs LSRA seed)', () => {
  beforeAll(async () => {
    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true, min_participants: 1 },
      },
      select: { id: true, activity_id: true },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public min-1 rate found in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    rateId = rate.id;

    await purgeTestData();

    // Two roomy source slots (one booking each) and ONE destination with room for
    // exactly one seat.
    srcA = await makeSlot(40 * DAY, 5);
    srcB = await makeSlot(41 * DAY, 5);
    dest = await makeSlot(45 * DAY, 1);

    const book = (email: string, first: string, timeslotId: string) =>
      createBooking(
        OP,
        {
          activityId,
          rateId,
          timeslotId,
          quantity: 1,
          customer: { first_name: first, last_name: 'Resched', email },
          participants: [],
        },
        { channel: 'CUSTOMER' },
      );

    const a = await book(EMAIL_A, 'Alice', srcA);
    const b = await book(EMAIL_B, 'Bob', srcB);
    orderIdA = a.id;
    orderIdB = b.id;
  });

  afterAll(async () => {
    await purgeTestData();
    for (const id of [srcA, srcB, dest]) {
      if (id) await adminPrisma.timeslot.deleteMany({ where: { id } });
    }
    await adminPrisma.$disconnect();
  });

  it('serialises two parallel reschedules onto a 1-capacity slot: one wins, one is refused', async () => {
    const results = await Promise.allSettled([
      rescheduleBooking(OP, orderIdA, dest, { channel: 'CUSTOMER' }),
      rescheduleBooking(OP, orderIdB, dest, { channel: 'CUSTOMER' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one reschedule committed.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser failed on capacity, not a crash / deadlock / unexpected error.
    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(BookingError);
    expect((err as BookingError).code).toBe('INSUFFICIENT_CAPACITY');

    // The destination holds exactly one seat — never two on a 1-capacity slot.
    const destSlot = await adminPrisma.timeslot.findUnique({ where: { id: dest } });
    expect(destSlot!.capacity_booked).toBe(1);
    expect(destSlot!.status).toBe('FULL');

    // Exactly one item actually points at the destination; the two source slots
    // together still hold exactly one seat (the loser never moved).
    const destItems = await adminPrisma.orderItem.count({ where: { timeslot_id: dest } });
    expect(destItems).toBe(1);

    const srcASlot = await adminPrisma.timeslot.findUnique({ where: { id: srcA } });
    const srcBSlot = await adminPrisma.timeslot.findUnique({ where: { id: srcB } });
    expect(srcASlot!.capacity_booked + srcBSlot!.capacity_booked).toBe(1);
  });
});
