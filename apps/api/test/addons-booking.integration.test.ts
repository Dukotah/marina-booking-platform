/**
 * Add-ons at checkout — live integration test against the seeded Lake Sonoma
 * (LSRA) tenant on Neon. Proves the money path for the upsell engine now that it
 * is wired into the booking service:
 *
 *   - a booking created WITH add-on selections charges a total that is the seat
 *     line PLUS the server-derived add-on prices (taxed + fee'd through the SAME
 *     calculatePricing, so the add-on lines ride the one subtotal/tax/total);
 *   - a PER_GUEST add-on is priced against the party size, a PER_BOOKING add-on
 *     against the requested count;
 *   - a tampered / client-sent add-on price is IGNORED — the server re-reads the
 *     catalog price, so the charged total is identical whether the client lies
 *     about the price or not;
 *   - the add-on OrderItems are written with add_on_id + a name snapshot and the
 *     catalog unit price, and stock_sold is advanced by the reservation.
 *
 * SKIPS when DATABASE_URL is unset (plain `pnpm test` stays green pre-Neon). It
 * creates its own disposable add-ons + timeslot + customer and deletes everything
 * it made in afterAll, so it never pollutes the seed tenant and is safe to re-run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { calculatePricing, type PricingFee } from '@marina/core';
import { createBooking, cancelBooking } from '../src/services/booking.js';
import { createAddOn } from '../src/services/addons.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'addons-booking-itest@example.com';

const PER_BOOKING_PRICE = 2500; // $25 cooler
const PER_GUEST_PRICE = 1200; // $12 life jacket / guest
const TAMPERED_PRICE = 1; // what a malicious client would send instead

interface Fixture {
  activityId: string;
  rateId: string;
  ratePriceCents: number;
  maxParticipants: number;
  timeslotId: string;
  perBookingAddOnId: string;
  perGuestAddOnId: string;
}

let fx: Fixture;
const createdOrderIds: string[] = [];

/** Server-side fees for the activity, shaped for @marina/core (mirrors booking.ts). */
async function loadFees(activityId: string): Promise<PricingFee[]> {
  const rows = await adminPrisma.fee.findMany({
    where: { operator_id: OP, enabled: true, OR: [{ activity_id: activityId }, { activity_id: null }] },
    select: { name: true, type: true, value: true },
  });
  return rows.map((f) => ({ name: f.name, type: f.type, value: f.value }));
}

describe.skipIf(!HAS_DB)('add-ons at checkout (live vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    // A publicly-bookable rate on an active, online activity. Need room for a
    // 2-guest party, so pick one whose max >= 2.
    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true, max_participants: { gte: 2 } },
      },
      select: {
        id: true,
        price_cents: true,
        activity_id: true,
        activity: { select: { max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate (max>=2) in the LSRA seed — run `pnpm db:seed`.');

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    const db = forOperator(OP);
    const future = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    // Roomy slot: the two bookings below take qty 2 then qty 1. Slot capacity is a
    // separate axis from the per-booking participant max (both bookings stay within
    // the activity's max_participants), so give the slot plenty of seats so the
    // second booking is never starved by the first.
    const slot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: rate.activity_id,
        datetime: future,
        capacity_total: 10,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });

    // Two disposable add-ons scoped to this activity: one per-booking countable,
    // one per-guest. stock_total null (unlimited) so re-runs never deplete.
    const perBooking = await createAddOn(OP, {
      activityId: rate.activity_id,
      name: 'ITEST Cooler',
      description: null,
      priceCents: PER_BOOKING_PRICE,
      basis: 'PER_BOOKING',
      maxPerBooking: 10,
      stockTotal: null,
      isActive: true,
      sortIndex: 0,
    });
    const perGuest = await createAddOn(OP, {
      activityId: rate.activity_id,
      name: 'ITEST Life Jacket',
      description: null,
      priceCents: PER_GUEST_PRICE,
      basis: 'PER_GUEST',
      maxPerBooking: null,
      stockTotal: null,
      isActive: true,
      sortIndex: 1,
    });

    fx = {
      activityId: rate.activity_id,
      rateId: rate.id,
      ratePriceCents: rate.price_cents,
      maxParticipants: rate.activity.max_participants,
      timeslotId: slot.id,
      perBookingAddOnId: perBooking.id,
      perGuestAddOnId: perGuest.id,
    };
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await adminPrisma.order.deleteMany({ where: { id } });
    }
    if (fx?.perBookingAddOnId)
      await adminPrisma.packageUpsell.deleteMany({ where: { id: fx.perBookingAddOnId } });
    if (fx?.perGuestAddOnId)
      await adminPrisma.packageUpsell.deleteMany({ where: { id: fx.perGuestAddOnId } });
    if (fx?.timeslotId) await adminPrisma.timeslot.deleteMany({ where: { id: fx.timeslotId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('charges the seat total PLUS the server-derived add-on prices', async () => {
    const qty = 2; // party of two: per-guest add-on resolves to 2 units
    const cooler = 2; // two coolers

    const order = await createBooking(
      OP,
      {
        activityId: fx.activityId,
        rateId: fx.rateId,
        timeslotId: fx.timeslotId,
        quantity: qty,
        customer: { first_name: 'Addon', last_name: 'Buyer', email: TEST_EMAIL },
        participants: [],
        addOns: [
          { addOnId: fx.perBookingAddOnId, quantity: cooler },
          { addOnId: fx.perGuestAddOnId, quantity: 1 }, // per-guest => resolves to party size
        ],
      },
      { channel: 'CUSTOMER', actor: 'addons-booking.integration.test' },
    );
    createdOrderIds.push(order.id);

    // The authoritative expectation: one calculatePricing over the seat line PLUS
    // the two add-on lines priced from the catalog (per-guest × party size).
    const expected = calculatePricing({
      items: [
        { unitPriceCents: fx.ratePriceCents, quantity: qty },
        { unitPriceCents: PER_BOOKING_PRICE, quantity: cooler },
        { unitPriceCents: PER_GUEST_PRICE, quantity: qty },
      ],
      fees: await loadFees(fx.activityId),
      promo: null,
      tipCents: 0,
    });

    expect(order.subtotal_cents).toBe(expected.subtotalCents);
    expect(order.total_cents).toBe(expected.totalCents);

    // Sanity: the total genuinely grew by the add-ons vs a seats-only booking.
    const seatsOnly = calculatePricing({
      items: [{ unitPriceCents: fx.ratePriceCents, quantity: qty }],
      fees: await loadFees(fx.activityId),
      promo: null,
      tipCents: 0,
    });
    expect(order.total_cents).toBeGreaterThan(seatsOnly.totalCents);

    // The order graph: one seat item + two add-on items, each with add_on_id, a
    // name snapshot, and the CATALOG unit price.
    const items = await adminPrisma.orderItem.findMany({
      where: { order_id: order.id },
      orderBy: { unit_price_cents: 'asc' },
    });
    const addOnItems = items.filter((i) => i.add_on_id != null);
    expect(addOnItems).toHaveLength(2);

    const coolerItem = addOnItems.find((i) => i.add_on_id === fx.perBookingAddOnId)!;
    expect(coolerItem.unit_price_cents).toBe(PER_BOOKING_PRICE);
    expect(coolerItem.quantity).toBe(cooler);
    expect(coolerItem.add_on_name).toBe('ITEST Cooler');

    const jacketItem = addOnItems.find((i) => i.add_on_id === fx.perGuestAddOnId)!;
    expect(jacketItem.unit_price_cents).toBe(PER_GUEST_PRICE);
    expect(jacketItem.quantity).toBe(qty); // per-guest => party size

    // Stock advanced by the reservation (null stock_total still advances stock_sold).
    const coolerDef = await adminPrisma.packageUpsell.findUnique({
      where: { id: fx.perBookingAddOnId },
    });
    expect(coolerDef!.stock_sold).toBeGreaterThanOrEqual(cooler);
  });

  it('IGNORES a tampered client-sent add-on price (server re-prices from the catalog)', async () => {
    const qty = 1;

    // The malicious client sends a bogus unit price alongside the selection. The
    // booking schema strips it (it only accepts addOnId + quantity), and even if it
    // reached the service, resolveAddOnLines re-reads the catalog price. Either way
    // the charged total must equal the honest catalog price, NOT the tampered one.
    const order = await createBooking(
      OP,
      {
        activityId: fx.activityId,
        rateId: fx.rateId,
        timeslotId: fx.timeslotId,
        quantity: qty,
        customer: { first_name: 'Tamper', last_name: 'Attempt', email: TEST_EMAIL },
        participants: [],
        // Cast through unknown: the extra `priceCents`/`unitPriceCents` are exactly
        // what a hand-rolled request would smuggle; the type forbids them precisely
        // because the server is the price authority.
        addOns: [
          { addOnId: fx.perBookingAddOnId, quantity: 1, priceCents: TAMPERED_PRICE, unitPriceCents: TAMPERED_PRICE },
        ] as unknown as Array<{ addOnId: string; quantity: number }>,
      },
      { channel: 'CUSTOMER', actor: 'addons-booking.integration.test' },
    );
    createdOrderIds.push(order.id);

    const expectedHonest = calculatePricing({
      items: [
        { unitPriceCents: fx.ratePriceCents, quantity: qty },
        { unitPriceCents: PER_BOOKING_PRICE, quantity: 1 }, // the REAL catalog price
      ],
      fees: await loadFees(fx.activityId),
      promo: null,
      tipCents: 0,
    });

    expect(order.subtotal_cents).toBe(expectedHonest.subtotalCents);
    expect(order.total_cents).toBe(expectedHonest.totalCents);

    // And the persisted add-on line carries the catalog price, not the $0.01 tamper.
    const addOnItem = await adminPrisma.orderItem.findFirst({
      where: { order_id: order.id, add_on_id: fx.perBookingAddOnId },
    });
    expect(addOnItem!.unit_price_cents).toBe(PER_BOOKING_PRICE);
    expect(addOnItem!.unit_price_cents).not.toBe(TAMPERED_PRICE);
  });

  it('cancelBooking restores capacity for an order with add-ons', async () => {
    // Cancel everything we created so the disposable slot is drained before teardown.
    for (const id of createdOrderIds) {
      await cancelBooking(OP, id, { actor: 'addons-booking.integration.test', reason: 'test cleanup' });
    }
    const slot = await adminPrisma.timeslot.findUnique({ where: { id: fx.timeslotId } });
    expect(slot!.capacity_booked).toBe(0);
  });
});
