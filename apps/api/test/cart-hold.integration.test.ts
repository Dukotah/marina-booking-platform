/**
 * Cart-hold timer — live integration test against the seeded Lake Sonoma (LSRA)
 * tenant. Proves the three invariants the feature promises:
 *
 *   1. A hold SUBTRACTS from day availability — the seats it reserves stop showing
 *      as bookable the moment the hold exists, so a second guest can't reach "pay"
 *      for a seat the first is already holding.
 *   2. Expiry FREES the hold — an un-consumed hold whose expires_at has passed stops
 *      counting against availability (lazy on-read expiry), and the sweeper then
 *      deletes the dead row.
 *   3. Two racing holds for the LAST seat serialise — exactly one wins, the other is
 *      refused INSUFFICIENT_CAPACITY, and the slot is never over-held. This is the
 *      same FOR UPDATE row lock the booking engine uses.
 *
 * Also proves a booking CONSUMES its hold: after the order lands, the slot shows the
 * seat as booked (not double-counted as booked AND held).
 *
 * SKIPS when DATABASE_URL is unset. Creates its own disposable slots + holds and
 * deletes everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { createHold, runHoldsSweep, HoldError } from '../src/services/holds.js';
import { getDayAvailability } from '../src/services/availability.js';
import { createBooking } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const EMAIL = 'cart-hold-itest@example.com';

let activityId: string;
let rateId: string;

/** The operator-local calendar day a slot's datetime falls on (for getDayAvailability). */
function dayKeyFor(datetime: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(datetime);
}

async function purgeTestData(): Promise<void> {
  const custs = await adminPrisma.customer.findMany({
    where: { operator_id: OP, email: EMAIL },
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

const createdSlotIds: string[] = [];

/** A fresh future slot with the given capacity; tracked for cleanup. */
async function makeSlot(capacity: number): Promise<{ id: string; datetime: Date }> {
  const db = forOperator(OP);
  const future = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  const slot = await db.timeslot.create({
    data: {
      operator_id: OP,
      activity_id: activityId,
      datetime: future,
      capacity_total: capacity,
      capacity_booked: 0,
      status: 'AVAILABLE',
    },
    select: { id: true, datetime: true },
  });
  createdSlotIds.push(slot.id);
  return slot;
}

describe.skipIf(!HAS_DB)('cart-hold timer (live vs LSRA seed)', () => {
  let timeZone: string;

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
    if (!rate) throw new Error('No public min-1 rate in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    rateId = rate.id;

    const activity = await adminPrisma.activity.findUnique({
      where: { id: activityId },
      select: { operator: { select: { timezone: true } }, location: { select: { timezone: true } } },
    });
    timeZone = activity?.location?.timezone ?? activity?.operator.timezone ?? 'America/Los_Angeles';

    await purgeTestData();
  });

  afterAll(async () => {
    await purgeTestData();
    if (createdSlotIds.length) {
      await adminPrisma.cartHold.deleteMany({ where: { timeslot_id: { in: createdSlotIds } } });
      await adminPrisma.timeslot.deleteMany({ where: { id: { in: createdSlotIds } } });
    }
    await adminPrisma.$disconnect();
  });

  it('a hold subtracts from day availability', async () => {
    const slot = await makeSlot(3);
    const db = forOperator(OP);
    const date = dayKeyFor(slot.datetime, timeZone);

    const before = await getDayAvailability(db, { activityId, date });
    const slotBefore = before.timeslots.find((s) => s.id === slot.id)!;
    expect(slotBefore.capacityRemaining).toBe(3);

    await createHold(OP, { timeslotId: slot.id, seats: 2 });

    const after = await getDayAvailability(db, { activityId, date });
    const slotAfter = after.timeslots.find((s) => s.id === slot.id)!;
    // 3 total − 2 held = 1 sellable. The hold reserved capacity nobody has booked.
    expect(slotAfter.capacityRemaining).toBe(1);
  });

  it('an expired hold frees the seats (lazy on-read) and the sweeper deletes it', async () => {
    const slot = await makeSlot(1);
    const db = forOperator(OP);
    const date = dayKeyFor(slot.datetime, timeZone);

    // Plant a hold that has ALREADY expired (expires_at in the past).
    await db.cartHold.create({
      data: {
        operator_id: OP,
        timeslot_id: slot.id,
        seats: 1,
        expires_at: new Date(Date.now() - 60_000),
      },
    });

    // Lazy on-read: availability measures against `now`, so the lapsed hold does not
    // hide the seat — the slot reads fully available again.
    const avail = await getDayAvailability(db, { activityId, date });
    const slotView = avail.timeslots.find((s) => s.id === slot.id)!;
    expect(slotView.capacityRemaining).toBe(1);

    // Sweeper deletes the dead row so the table doesn't grow unbounded.
    const result = await runHoldsSweep();
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const remaining = await adminPrisma.cartHold.count({ where: { timeslot_id: slot.id } });
    expect(remaining).toBe(0);
  });

  it('two racing holds for the last seat: one wins, one is refused', async () => {
    const slot = await makeSlot(1);

    const results = await Promise.allSettled([
      createHold(OP, { timeslotId: slot.id, seats: 1 }),
      createHold(OP, { timeslotId: slot.id, seats: 1 }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(HoldError);
    expect((err as HoldError).code).toBe('INSUFFICIENT_CAPACITY');

    // Exactly one un-expired hold exists against the slot — never two on a 1-cap slot.
    const held = await adminPrisma.cartHold.aggregate({
      where: { timeslot_id: slot.id, consumed_at: null, expires_at: { gt: new Date() } },
      _sum: { seats: true },
    });
    expect(held._sum.seats).toBe(1);
  });

  it('a booking consumes its hold so the seat is not double-counted', async () => {
    const slot = await makeSlot(1);
    const db = forOperator(OP);
    const date = dayKeyFor(slot.datetime, timeZone);

    const hold = await createHold(OP, { timeslotId: slot.id, seats: 1 });

    // With the hold in place the slot is fully held → not bookable by anyone else.
    const heldView = (await getDayAvailability(db, { activityId, date })).timeslots.find(
      (s) => s.id === slot.id,
    )!;
    expect(heldView.capacityRemaining).toBe(0);

    // The guest who holds it books it, passing their holdId.
    await createBooking(
      OP,
      {
        activityId,
        rateId,
        timeslotId: slot.id,
        quantity: 1,
        customer: { first_name: 'Holder', last_name: 'Guest', email: EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER', holdId: hold.holdId },
    );

    // Seat is now booked, and the consumed hold no longer subtracts: remaining 0,
    // capacity_booked 1 (NOT 1 booked + 1 still-held = over-counted).
    const afterView = (await getDayAvailability(db, { activityId, date })).timeslots.find(
      (s) => s.id === slot.id,
    )!;
    expect(afterView.capacityRemaining).toBe(0);
    expect(afterView.capacityBooked).toBe(1);

    const liveHeld = await adminPrisma.cartHold.aggregate({
      where: { timeslot_id: slot.id, consumed_at: null, expires_at: { gt: new Date() } },
      _sum: { seats: true },
    });
    expect(liveHeld._sum.seats ?? 0).toBe(0);
  });
});
