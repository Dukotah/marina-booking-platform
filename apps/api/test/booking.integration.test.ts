/**
 * Booking service — live integration test against the seeded Lake Sonoma (LSRA)
 * tenant on Neon. This exercises the real money path end-to-end (the Phase-1 sweep
 * code that until now was only typecheck/build-verified), proving that against a
 * real database:
 *   - createBooking recomputes pricing server-side and matches @marina/core,
 *   - it decrements timeslot capacity and writes the full order graph (item +
 *     OrderEvent + customer),
 *   - it refuses to overbook past remaining capacity, and
 *   - cancelBooking restores the capacity it held.
 *
 * It SKIPS when DATABASE_URL is unset (so plain `pnpm test` stays green pre-Neon),
 * and it auto-runs live once the connection string is in .env. It creates its own
 * disposable timeslot + customer and deletes everything it made in afterAll, so it
 * never pollutes the seed tenant and is safe to re-run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { calculatePricing, type PricingFee } from '@marina/core';
import { createBooking, cancelBooking, BookingError } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'booking-itest@example.com';

interface Fixture {
  activityId: string;
  rateId: string;
  ratePriceCents: number;
  minParticipants: number;
  maxParticipants: number;
  timeslotId: string;
}

let fx: Fixture;
let createdOrderId: string | null = null;

/** Server-side fees for the activity, shaped for @marina/core (mirrors booking.ts). */
async function loadFees(activityId: string): Promise<PricingFee[]> {
  const rows = await adminPrisma.fee.findMany({
    where: { operator_id: OP, enabled: true, OR: [{ activity_id: activityId }, { activity_id: null }] },
    select: { name: true, type: true, value: true },
  });
  return rows.map((f) => ({ name: f.name, type: f.type, value: f.value }));
}

describe.skipIf(!HAS_DB)('booking service (live vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    // Pick a publicly-bookable rate on an active, online activity from the seed.
    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true },
      },
      select: {
        id: true,
        price_cents: true,
        activity_id: true,
        activity: { select: { min_participants: true, max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');

    // Clean any leftover test customer from a previous run.
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });

    // Create a disposable future timeslot whose capacity == the activity max, so a
    // full-capacity booking attempt is guaranteed to exceed the remaining spots.
    const db = forOperator(OP);
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // ~30 days out
    const slot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: rate.activity_id,
        datetime: future,
        capacity_total: rate.activity.max_participants,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });

    fx = {
      activityId: rate.activity_id,
      rateId: rate.id,
      ratePriceCents: rate.price_cents,
      minParticipants: rate.activity.min_participants,
      maxParticipants: rate.activity.max_participants,
      timeslotId: slot.id,
    };
  });

  afterAll(async () => {
    // Deleting the order cascades its items / events / payments. Then drop the
    // disposable timeslot and the test customer.
    if (createdOrderId) await adminPrisma.order.deleteMany({ where: { id: createdOrderId } });
    if (fx?.timeslotId) await adminPrisma.timeslot.deleteMany({ where: { id: fx.timeslotId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('creates a booking with server-recomputed pricing and the full order graph', async () => {
    const qty = fx.minParticipants;
    const order = await createBooking(
      OP,
      {
        activityId: fx.activityId,
        rateId: fx.rateId,
        timeslotId: fx.timeslotId,
        quantity: qty,
        customer: { first_name: 'Itest', last_name: 'Booker', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER', actor: 'booking.integration.test' },
    );
    createdOrderId = order.id;

    // Pricing must match what @marina/core computes from the DB rate + fees.
    const expected = calculatePricing({
      items: [{ unitPriceCents: fx.ratePriceCents, quantity: qty }],
      fees: await loadFees(fx.activityId),
      promo: null,
      tipCents: 0,
    });
    expect(order.subtotal_cents).toBe(expected.subtotalCents);
    expect(order.total_cents).toBe(expected.totalCents);
    expect(order.balance_due_cents).toBe(expected.totalCents); // unpaid at creation

    // Order graph: exactly one item, a customer, and an audit event.
    const items = await adminPrisma.orderItem.findMany({ where: { order_id: order.id } });
    expect(items).toHaveLength(1);
    expect(items[0]!.quantity).toBe(qty);
    expect(items[0]!.operator_id).toBe(OP); // derived from the parent (D-011)

    const events = await adminPrisma.orderEvent.findMany({ where: { order_id: order.id } });
    expect(events.some((e) => e.type === 'ORDER_CREATED')).toBe(true);

    const customer = await adminPrisma.customer.findFirst({
      where: { operator_id: OP, email: TEST_EMAIL },
    });
    expect(customer).not.toBeNull();

    // Capacity was decremented by the booked quantity.
    const slot = await adminPrisma.timeslot.findUnique({ where: { id: fx.timeslotId } });
    expect(slot!.capacity_booked).toBe(qty);
  });

  it('refuses to overbook past the remaining capacity', async () => {
    // The slot now has (max - min) spots left; asking for the full max must fail.
    await expect(
      createBooking(
        OP,
        {
          activityId: fx.activityId,
          rateId: fx.rateId,
          timeslotId: fx.timeslotId,
          quantity: fx.maxParticipants,
          customer: { first_name: 'Over', last_name: 'Booker', email: TEST_EMAIL },
          participants: [],
        },
        { channel: 'CUSTOMER' },
      ),
    ).rejects.toThrow(BookingError);

    // The failed attempt must not have moved capacity.
    const slot = await adminPrisma.timeslot.findUnique({ where: { id: fx.timeslotId } });
    expect(slot!.capacity_booked).toBe(fx.minParticipants);
  });

  it('cancelBooking restores the capacity it held', async () => {
    expect(createdOrderId).not.toBeNull();
    await cancelBooking(OP, createdOrderId!, { actor: 'booking.integration.test', reason: 'test cleanup' });

    const slot = await adminPrisma.timeslot.findUnique({ where: { id: fx.timeslotId } });
    expect(slot!.capacity_booked).toBe(0);

    const order = await adminPrisma.order.findUnique({ where: { id: createdOrderId! } });
    expect(order!.status).toBe('CANCELLED');
  });
});
