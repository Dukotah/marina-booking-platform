/**
 * Open-duration RENTAL booking engine — live integration against the LSRA tenant.
 *
 * Proves the rental-window columns finally have a consumer that is coherent with
 * the existing order/booking/resource model:
 *   1) AVAILABILITY reflects an existing rental booking — the taken span is carved
 *      out of the free gaps and the bookable start grid.
 *   2) A VALID rental books — it slots into the ordinary order model (Order +
 *      OrderItem + Timeslot + ResourceBooking) exactly like any booking.
 *   3) An OVERLAPPING rental is rejected (409), because the shared boat is taken.
 *   4) A RACE between two identical rentals yields exactly ONE winner (the loser is
 *      a typed INSUFFICIENT_RESOURCE / SLOT_TAKEN), never an oversell.
 *   5) FIXED-DEPARTURE boats are UNAFFECTED: the rental path refuses them and their
 *      discrete-timeslot availability/booking still works.
 *
 * Everything is disposable (own activities, rates, resource, rules) and torn down
 * in afterAll, so it never pollutes the seed and is safe to re-run. SKIPS without
 * DATABASE_URL so plain `pnpm test` stays green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { createBooking, cancelBooking, BookingError } from '../src/services/booking.js';
import {
  createRentalBooking,
  getRentalAvailability,
  isRentalActivity,
  RentalError,
} from '../src/services/rental.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'rental-itest@example.com';
const DURATION_MIN = 120; // a 2-hour rental
const OPEN_MIN = 8 * 60; // 8:00 AM
const CLOSE_MIN = 20 * 60; // 8:00 PM

/** A future weekday (operator-local date is fine — rules cover every day). */
function futureIsoDate(daysAhead: number): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

interface Fx {
  resourceId: string;
  rentalActivity: string;
  rentalRate: string;
  // A second rental activity sharing the SAME pool, to prove cross-activity overlap.
  rentalActivityB: string;
  rentalRateB: string;
  // A fixed-departure activity (NOT a rental) to prove it is untouched.
  tourActivity: string;
  tourRate: string;
  tourSlot: string;
  date: string;
  dateB: string;
}

let fx: Fx;
const createdOrderIds: string[] = [];

async function makeActivity(name: string): Promise<string> {
  const a = await adminPrisma.activity.create({
    data: {
      operator_id: OP,
      name_internal: name,
      name_external: name,
      status: 'ACTIVE',
      category: 'BOAT',
      visible_online: true,
      min_participants: 1,
      max_participants: 6,
    },
    select: { id: true },
  });
  return a.id;
}

async function makeRate(activityId: string): Promise<string> {
  const r = await adminPrisma.rate.create({
    data: {
      operator_id: OP,
      activity_id: activityId,
      name_internal: '2 hours',
      name_external: '2 hours',
      price_cents: 12000,
      duration_minutes: DURATION_MIN,
      is_active: true,
    },
    select: { id: true },
  });
  return r.id;
}

/** Attach an open-duration rental-window rule (every day OPEN..CLOSE) to an activity. */
async function makeRentalRule(activityId: string): Promise<void> {
  await adminPrisma.scheduleRule.create({
    data: {
      operator_id: OP,
      activity_id: activityId,
      name: 'ITEST rental window',
      start_date: '2026-01-01',
      end_date: '2027-12-31',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      start_minutes: [], // empty => open-duration rental window
      open_minute: OPEN_MIN,
      close_minute: CLOSE_MIN,
      capacity: null,
      is_active: true,
    },
  });
}

function bookRental(
  activityId: string,
  rateId: string,
  date: string,
  startMinute: number,
  qty = 1,
  email = TEST_EMAIL,
) {
  return createRentalBooking(
    OP,
    {
      activityId,
      date,
      startMinute,
      rateId,
      quantity: qty,
      customer: { first_name: 'Rent', last_name: 'Itest', email },
    },
    { actor: 'rental-booking.integration.test' },
  );
}

describe.skipIf(!HAS_DB)('open-duration rental booking (live vs LSRA)', () => {
  beforeAll(async () => {
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    const rentalActivity = await makeActivity('ITEST Rental Boat A');
    const rentalActivityB = await makeActivity('ITEST Rental Boat B');
    const tourActivity = await makeActivity('ITEST Tour Boat');

    const rentalRate = await makeRate(rentalActivity);
    const rentalRateB = await makeRate(rentalActivityB);
    const tourRate = await makeRate(tourActivity);

    await makeRentalRule(rentalActivity);
    await makeRentalRule(rentalActivityB);

    // ONE shared pool of a single unit, shared by BOTH rental activities, so a
    // booking on A blocks an overlapping rental on B (cross-activity overlap).
    const resource = await adminPrisma.resource.create({
      data: {
        operator_id: OP,
        name: 'ITEST Rental Pontoon',
        seat_capacity: 6,
        quantity: 1, // exactly one boat
        out_of_service_qty: 0,
        is_active: true,
        activities: { connect: [{ id: rentalActivity }, { id: rentalActivityB }] },
      },
      select: { id: true },
    });

    // Fixed-departure tour boat: one discrete timeslot, NO rental rule.
    const w = new Date(Date.now() + 30 * 86_400_000);
    const tourSlot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: tourActivity,
        datetime: w,
        capacity_total: 6,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });

    fx = {
      resourceId: resource.id,
      rentalActivity,
      rentalRate,
      rentalActivityB,
      rentalRateB,
      tourActivity,
      tourRate,
      tourSlot: tourSlot.id,
      date: futureIsoDate(30),
      dateB: futureIsoDate(31),
    };
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await adminPrisma.order.deleteMany({ where: { id } });
    }
    if (fx) {
      await adminPrisma.resource.deleteMany({ where: { id: fx.resourceId } });
      await adminPrisma.scheduleRule.deleteMany({
        where: { activity_id: { in: [fx.rentalActivity, fx.rentalActivityB] } },
      });
      // One-off timeslots the rental path materialized, plus the tour slot.
      await adminPrisma.timeslot.deleteMany({
        where: { activity_id: { in: [fx.rentalActivity, fx.rentalActivityB, fx.tourActivity] } },
      });
      await adminPrisma.rate.deleteMany({
        where: { id: { in: [fx.rentalRate, fx.rentalRateB, fx.tourRate] } },
      });
      await adminPrisma.activity.deleteMany({
        where: { id: { in: [fx.rentalActivity, fx.rentalActivityB, fx.tourActivity] } },
      });
    }
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('classifies rental vs fixed-departure activities', async () => {
    expect(await isRentalActivity(adminPrisma as never, fx.rentalActivity)).toBe(true);
    expect(await isRentalActivity(adminPrisma as never, fx.tourActivity)).toBe(false);
  });

  it('exposes the open window and bookable starts on a fresh day', async () => {
    const avail = await getRentalAvailability(adminPrisma as never, {
      activityId: fx.rentalActivity,
      date: fx.date,
      rateId: fx.rentalRate,
    });
    expect(avail.closed).toBe(false);
    expect(avail.windows).toEqual([{ open: OPEN_MIN, close: CLOSE_MIN }]);
    expect(avail.freeGaps).toEqual([{ open: OPEN_MIN, close: CLOSE_MIN }]);
    const rate = avail.rates.find((r) => r.rateId === fx.rentalRate)!;
    // 8:00..20:00 window, 2h rental, 30-min grid -> first start 8:00, last 18:00.
    expect(rate.startMinutes[0]).toBe(OPEN_MIN);
    expect(rate.startMinutes.at(-1)).toBe(CLOSE_MIN - DURATION_MIN);
  });

  it('books a valid rental and slots it into the order model', async () => {
    const order = await bookRental(fx.rentalActivity, fx.rentalRate, fx.date, 10 * 60); // 10:00
    createdOrderIds.push(order.id);

    // It's a real order with an item on a materialized timeslot.
    expect(order.items).toHaveLength(1);
    const item = order.items[0]!;
    expect(item.activity_id).toBe(fx.rentalActivity);

    // The timeslot sits at 10:00 local; a ResourceBooking holds the 10:00..12:00 window.
    const rb = await adminPrisma.resourceBooking.findMany({
      where: { resource_id: fx.resourceId, order_item_id: item.id },
    });
    expect(rb).toHaveLength(1);
    expect(rb[0]!.ends_at.getTime() - rb[0]!.starts_at.getTime()).toBe(DURATION_MIN * 60_000);

    // Quote == charge: integer-cents total is the rate price for one unit (+ any fees).
    expect(order.total_cents).toBeGreaterThanOrEqual(12000);
  });

  it('availability now reflects the existing rental booking', async () => {
    const avail = await getRentalAvailability(adminPrisma as never, {
      activityId: fx.rentalActivity,
      date: fx.date,
      rateId: fx.rentalRate,
    });
    // The 10:00..12:00 booking carves the window into two free gaps.
    expect(avail.freeGaps).toEqual([
      { open: OPEN_MIN, close: 10 * 60 },
      { open: 12 * 60, close: CLOSE_MIN },
    ]);
    const rate = avail.rates.find((r) => r.rateId === fx.rentalRate)!;
    // A 2h rental starting at 10:00 or 11:00 no longer fits; 8:00 and 12:00 do.
    expect(rate.startMinutes).toContain(OPEN_MIN);
    expect(rate.startMinutes).toContain(12 * 60);
    expect(rate.startMinutes).not.toContain(10 * 60);
    expect(rate.startMinutes).not.toContain(11 * 60);
  });

  it('rejects an OVERLAPPING rental on the same boat (409)', async () => {
    // 11:00..13:00 overlaps the 10:00..12:00 booking on the shared pool.
    await expect(bookRental(fx.rentalActivity, fx.rentalRate, fx.date, 11 * 60)).rejects.toMatchObject(
      { status: 409 },
    );
  });

  it('rejects an overlapping rental on a DIFFERENT activity sharing the pool', async () => {
    // Boat B, same pool, same day, overlapping window -> the shared boat is taken.
    // The availability guard sees the pool's taken span (it reads ResourceBooking
    // across ALL activities on the pool, not just this one) and refuses with a 409
    // SLOT_TAKEN before the engine even runs — proving cross-activity overlap is
    // honoured. (Were the guard bypassed, the engine's overlap lock is the backstop.)
    await expect(
      bookRental(fx.rentalActivityB, fx.rentalRateB, fx.date, 11 * 60),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('allows a NON-overlapping rental later the same day', async () => {
    const order = await bookRental(fx.rentalActivity, fx.rentalRate, fx.date, 13 * 60); // 13:00..15:00
    createdOrderIds.push(order.id);
    const count = await adminPrisma.resourceBooking.count({
      where: { resource_id: fx.resourceId },
    });
    expect(count).toBe(2); // the 10:00 and the 13:00 rentals
  });

  it('rejects a start+duration that spills past the close edge', async () => {
    // 19:00 + 2h = 21:00 > 20:00 close.
    await expect(
      bookRental(fx.rentalActivityB, fx.rentalRateB, fx.dateB, 19 * 60),
    ).rejects.toMatchObject({ code: 'OUTSIDE_WINDOW' });
  });

  it('refuses the rental path for a fixed-departure boat', async () => {
    await expect(
      getRentalAvailability(adminPrisma as never, {
        activityId: fx.tourActivity,
        date: fx.date,
      }),
    ).rejects.toMatchObject({ code: 'NOT_RENTAL' });
  });

  it('leaves the fixed-departure boat bookable the old way (untouched)', async () => {
    const order = await createBooking(
      OP,
      {
        activityId: fx.tourActivity,
        rateId: fx.tourRate,
        timeslotId: fx.tourSlot,
        quantity: 2,
        customer: { first_name: 'Tour', last_name: 'Itest', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'STAFF', actor: 'rental-booking.integration.test' },
    );
    createdOrderIds.push(order.id);
    expect(order.items[0]!.timeslot_id).toBe(fx.tourSlot);
  });

  it('cancelling a rental frees its window again', async () => {
    // Cancel the first rental (10:00..12:00); its window re-opens.
    await cancelBooking(OP, createdOrderIds[0]!, { actor: 'rental-booking.integration.test' });
    const avail = await getRentalAvailability(adminPrisma as never, {
      activityId: fx.rentalActivity,
      date: fx.date,
      rateId: fx.rentalRate,
    });
    // Only the 13:00..15:00 rental remains taken now.
    expect(avail.freeGaps).toEqual([
      { open: OPEN_MIN, close: 13 * 60 },
      { open: 15 * 60, close: CLOSE_MIN },
    ]);
  });
});

/**
 * Concurrency: two identical rentals for the SAME boat/window fired at once. The
 * ResourceBooking overlap under the per-pool advisory lock (inherited from the
 * booking engine) must let exactly ONE win — never oversell the single boat.
 * Isolated fixtures so the race never touches the sequential suite.
 */
describe.skipIf(!HAS_DB)('open-duration rental — concurrency (live vs LSRA)', () => {
  const CEMAIL = 'rental-conc-itest@example.com';
  const orderIds: string[] = [];
  let resourceId: string;
  let activityId: string;
  let rateId: string;
  let date: string;

  beforeAll(async () => {
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: CEMAIL } });
    activityId = await makeActivity('ITEST Rental Conc');
    rateId = await makeRate(activityId);
    await makeRentalRule(activityId);
    const resource = await adminPrisma.resource.create({
      data: {
        operator_id: OP,
        name: 'ITEST Rental Conc Boat',
        seat_capacity: 6,
        quantity: 1, // one boat — a single rental window can hold only one booking
        out_of_service_qty: 0,
        is_active: true,
        activities: { connect: [{ id: activityId }] },
      },
      select: { id: true },
    });
    resourceId = resource.id;
    date = futureIsoDate(33);
  });

  afterAll(async () => {
    for (const id of orderIds) await adminPrisma.order.deleteMany({ where: { id } });
    await adminPrisma.resource.deleteMany({ where: { id: resourceId } });
    await adminPrisma.scheduleRule.deleteMany({ where: { activity_id: activityId } });
    await adminPrisma.timeslot.deleteMany({ where: { activity_id: activityId } });
    await adminPrisma.rate.deleteMany({ where: { id: rateId } });
    await adminPrisma.activity.deleteMany({ where: { id: activityId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: CEMAIL } });
  });

  it('two racing rentals for the same boat/window -> exactly one winner', async () => {
    const mk = () =>
      createRentalBooking(
        OP,
        {
          activityId,
          date,
          startMinute: 9 * 60, // both want 9:00..11:00
          rateId,
          quantity: 6, // the whole boat
          customer: { first_name: 'Conc', last_name: 'Itest', email: CEMAIL },
        },
        { actor: 'rental-booking.integration.test' },
      );

    const results = await Promise.allSettled([mk(), mk()]);
    for (const r of results) {
      if (r.status === 'fulfilled') orderIds.push(r.value.id);
    }

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    // Exactly one wins; the loser is a typed 409, not a crash or a second booking.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = rejected[0]!.reason;
    expect(reason instanceof BookingError || reason instanceof RentalError).toBe(true);
    expect((reason as { status: number }).status).toBe(409);

    // Ground truth: the single boat holds no more than its 6 seats for the window.
    const held = await adminPrisma.resourceBooking.findMany({
      where: { resource_id: resourceId },
    });
    expect(held.reduce((n, r) => n + r.seats, 0)).toBeLessThanOrEqual(6);
  });
});
