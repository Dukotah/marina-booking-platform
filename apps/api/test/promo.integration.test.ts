/**
 * Promo codes in the booking path — live integration test against the seeded LSRA
 * tenant on Neon. Promo discounts move money, so we prove against real data that:
 *   - a valid, active percent-off code is resolved server-side, applied to the
 *     pricing (matching @marina/core), and increments the code's redemption count;
 *   - the seed's LASTSPLASH code (is_active=false + expired) is REJECTED, so an
 *     inactive/expired code can never discount a booking.
 *
 * Skips without DATABASE_URL. Creates a disposable active promo + timeslot and
 * deletes everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { calculatePricing, type PricingFee } from '@marina/core';
import { createBooking, BookingError } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'promo-itest@example.com';
const PROMO_CODE = 'ITEST-PROMO10';
const DISCOUNT_PCT = 10;

let activityId = '';
let rateId = '';
let ratePriceCents = 0;
let qty = 1;
let timeslotId = '';
let promoId = '';
let createdOrderId: string | null = null;

async function loadFees(): Promise<PricingFee[]> {
  const rows = await adminPrisma.fee.findMany({
    where: { operator_id: OP, enabled: true, OR: [{ activity_id: activityId }, { activity_id: null }] },
    select: { name: true, type: true, value: true },
  });
  return rows.map((f) => ({ name: f.name, type: f.type, value: f.value }));
}

describe.skipIf(!HAS_DB)('promo codes in booking (live vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
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
    activityId = rate.activity_id;
    rateId = rate.id;
    ratePriceCents = rate.price_cents;
    qty = rate.activity.min_participants;

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.promoCode.deleteMany({ where: { operator_id: OP, code: PROMO_CODE } });

    // Disposable active promo: percent-off, no date window, applies to all activities.
    const db = forOperator(OP);
    const promo = await db.promoCode.create({
      data: {
        operator_id: OP,
        code: PROMO_CODE,
        name: 'Integration test promo',
        type: 'ONE_CODE',
        discount_type: 'PERCENT',
        discount_value: DISCOUNT_PCT,
        is_active: true,
        activity_ids: [],
      },
      select: { id: true },
    });
    promoId = promo.id;

    const slot = await db.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 32 * 24 * 60 * 60 * 1000),
        capacity_total: rate.activity.max_participants,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    timeslotId = slot.id;
  });

  afterAll(async () => {
    if (createdOrderId) await adminPrisma.order.deleteMany({ where: { id: createdOrderId } });
    if (timeslotId) await adminPrisma.timeslot.deleteMany({ where: { id: timeslotId } });
    if (promoId) await adminPrisma.promoCode.deleteMany({ where: { id: promoId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('applies a valid percent-off code and increments its redemption count', async () => {
    const order = await createBooking(
      OP,
      {
        activityId,
        rateId,
        timeslotId,
        quantity: qty,
        customer: { first_name: 'Promo', last_name: 'User', email: TEST_EMAIL },
        participants: [],
        promoCode: PROMO_CODE,
      },
      { channel: 'CUSTOMER' },
    );
    createdOrderId = order.id;

    const expected = calculatePricing({
      items: [{ unitPriceCents: ratePriceCents, quantity: qty }],
      fees: await loadFees(),
      promo: { discountType: 'PERCENT', discountValue: DISCOUNT_PCT },
      tipCents: 0,
    });
    expect(expected.discountCents).toBeGreaterThan(0); // sanity: a discount actually applied
    expect(order.discount_cents).toBe(expected.discountCents);
    expect(order.total_cents).toBe(expected.totalCents);
    expect(order.promo_code_id).toBe(promoId);

    // The redemption counter must have incremented exactly once.
    const promo = await adminPrisma.promoCode.findUnique({
      where: { id: promoId },
      select: { times_redeemed: true },
    });
    expect(promo!.times_redeemed).toBe(1);
  });

  it("rejects the seed's inactive/expired LASTSPLASH code", async () => {
    await expect(
      createBooking(
        OP,
        {
          activityId,
          rateId,
          timeslotId,
          quantity: qty,
          customer: { first_name: 'Expired', last_name: 'Promo', email: TEST_EMAIL },
          participants: [],
          promoCode: 'LASTSPLASH',
        },
        { channel: 'CUSTOMER' },
      ),
    ).rejects.toThrow(BookingError);
  });
});
