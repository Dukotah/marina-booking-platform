/**
 * Overbooking TOCTOU regression — live integration test against the seeded Lake
 * Sonoma (LSRA) tenant. Fires two bookings in parallel at a slot with room for
 * exactly ONE seat and proves the row lock in createBooking serialises them:
 * exactly one commits, the other fails INSUFFICIENT_CAPACITY, and the slot ends
 * with capacity_booked == 1 (never 2 seats on a 1-capacity slot).
 *
 * Without the `SELECT ... FOR UPDATE` lock both transactions read capacity_booked
 * = 0 under READ COMMITTED, both pass the app-code capacity check, and both write
 * old+qty — the exact overbooking the preflight reproduced.
 *
 * SKIPS when DATABASE_URL is unset. Creates its own disposable 1-capacity slot and
 * a unique customer per booker, and deletes everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { createBooking, BookingError } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const EMAIL_A = 'race-a-itest@example.com';
const EMAIL_B = 'race-b-itest@example.com';

let activityId: string;
let rateId: string;
let timeslotId: string;

/**
 * Delete the test customers and everything referencing them. Order has a RESTRICT
 * FK to Customer, so orders (which cascade their items/events/payments) must go
 * first — otherwise a leftover order from an interrupted run blocks the customer
 * delete. Runs in both beforeAll and afterAll so the test self-heals.
 */
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

describe.skipIf(!HAS_DB)('booking overbooking race (live vs LSRA seed)', () => {
  beforeAll(async () => {
    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        // A single-seat booking must be allowed, so min_participants must be 1.
        activity: { status: 'ACTIVE', visible_online: true, min_participants: 1 },
      },
      select: { id: true, activity_id: true },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public min-1 rate found in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    rateId = rate.id;

    await purgeTestData();

    // A slot with room for exactly ONE seat.
    const db = forOperator(OP);
    const future = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);
    const slot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: future,
        capacity_total: 1,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    timeslotId = slot.id;
  });

  afterAll(async () => {
    await purgeTestData();
    if (timeslotId) await adminPrisma.timeslot.deleteMany({ where: { id: timeslotId } });
    await adminPrisma.$disconnect();
  });

  it('serialises two parallel bookings on a 1-capacity slot: one wins, one is refused', async () => {
    const book = (email: string, first: string) =>
      createBooking(
        OP,
        {
          activityId,
          rateId,
          timeslotId,
          quantity: 1,
          customer: { first_name: first, last_name: 'Racer', email },
          participants: [],
        },
        { channel: 'CUSTOMER' },
      );

    const results = await Promise.allSettled([book(EMAIL_A, 'Alice'), book(EMAIL_B, 'Bob')]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one booking committed.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser failed on capacity, not a crash / deadlock / unexpected error.
    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(BookingError);
    expect((err as BookingError).code).toBe('INSUFFICIENT_CAPACITY');

    // The slot holds exactly one seat — never two on a 1-capacity slot.
    const slot = await adminPrisma.timeslot.findUnique({ where: { id: timeslotId } });
    expect(slot!.capacity_booked).toBe(1);
    expect(slot!.status).toBe('FULL');

    // And exactly one order actually exists against this slot.
    const orders = await adminPrisma.orderItem.count({ where: { timeslot_id: timeslotId } });
    expect(orders).toBe(1);
  });
});
