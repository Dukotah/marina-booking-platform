/**
 * Auto-apply promos + per-customer redemption limits in the booking path — live
 * integration test against the seeded LSRA tenant. Promo discounts move money, so
 * we prove against real data that:
 *   - with NO code typed, checkout auto-applies the best active AUTO promo and the
 *     discount shown == the amount charged (re-derived server-side via @marina/core);
 *   - a customer who has already hit a promo's per_customer_limit is REJECTED when
 *     they type that code again, while the overall counter never over-counts.
 *
 * Skips without DATABASE_URL. Creates disposable promos + timeslots and deletes
 * everything it made in afterAll (narrow, id-scoped).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { calculatePricing, type PricingFee } from '@marina/core';
import { createBooking, BookingError } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const AUTO_EMAIL = 'promo-auto-itest@example.com';
const LIMIT_EMAIL = 'promo-limit-itest@example.com';
const AUTO_CODE = 'ITEST-AUTO15';
const LIMIT_CODE = 'ITEST-PERCUST1';
const AUTO_PCT = 15;
const LIMIT_PCT = 20;

let activityId = '';
let rateId = '';
let ratePriceCents = 0;
let qty = 1;
let autoPromoId = '';
let limitPromoId = '';
const timeslotIds: string[] = [];
const createdOrderIds: string[] = [];

async function loadFees(): Promise<PricingFee[]> {
  const rows = await adminPrisma.fee.findMany({
    where: { operator_id: OP, enabled: true, OR: [{ activity_id: activityId }, { activity_id: null }] },
    select: { name: true, type: true, value: true },
  });
  return rows.map((f) => ({ name: f.name, type: f.type, value: f.value }));
}

async function makeSlot(): Promise<string> {
  const db = forOperator(OP);
  const slot = await db.timeslot.create({
    data: {
      operator_id: OP,
      activity_id: activityId,
      datetime: new Date(Date.now() + (33 + timeslotIds.length) * 24 * 60 * 60 * 1000),
      capacity_total: 50,
      capacity_booked: 0,
      status: 'AVAILABLE',
    },
    select: { id: true },
  });
  timeslotIds.push(slot.id);
  return slot.id;
}

describe.skipIf(!HAS_DB)('auto-apply + per-customer promo limits (live, LSRA seed)', () => {
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
        activity: { select: { min_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    rateId = rate.id;
    ratePriceCents = rate.price_cents;
    qty = rate.activity.min_participants;

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: { in: [AUTO_EMAIL, LIMIT_EMAIL] } } });
    await adminPrisma.promoCode.deleteMany({ where: { operator_id: OP, code: { in: [AUTO_CODE, LIMIT_CODE] } } });

    const db = forOperator(OP);
    const auto = await db.promoCode.create({
      data: {
        operator_id: OP,
        code: AUTO_CODE,
        name: 'Integration test auto promo',
        type: 'AUTO',
        discount_type: 'PERCENT',
        discount_value: AUTO_PCT,
        is_active: true,
        auto_apply: true,
        activity_ids: [],
      },
      select: { id: true },
    });
    autoPromoId = auto.id;

    const limited = await db.promoCode.create({
      data: {
        operator_id: OP,
        code: LIMIT_CODE,
        name: 'Integration test per-customer promo',
        type: 'PER_CUSTOMER',
        discount_type: 'PERCENT',
        discount_value: LIMIT_PCT,
        is_active: true,
        auto_apply: false,
        per_customer_limit: 1,
        activity_ids: [],
      },
      select: { id: true },
    });
    limitPromoId = limited.id;
  });

  afterAll(async () => {
    if (createdOrderIds.length) await adminPrisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    await adminPrisma.promoRedemption.deleteMany({
      where: { promo_code_id: { in: [autoPromoId, limitPromoId].filter(Boolean) } },
    });
    if (timeslotIds.length) await adminPrisma.timeslot.deleteMany({ where: { id: { in: timeslotIds } } });
    await adminPrisma.promoCode.deleteMany({ where: { id: { in: [autoPromoId, limitPromoId].filter(Boolean) } } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: { in: [AUTO_EMAIL, LIMIT_EMAIL] } } });
    await adminPrisma.$disconnect();
  });

  it('auto-applies the best active AUTO promo when no code is typed', async () => {
    const timeslotId = await makeSlot();
    const order = await createBooking(
      OP,
      {
        activityId,
        rateId,
        timeslotId,
        quantity: qty,
        customer: { first_name: 'Auto', last_name: 'Guest', email: AUTO_EMAIL },
        participants: [],
        // NOTE: no promoCode passed — the server must pick the AUTO promo itself.
      },
      { channel: 'CUSTOMER' },
    );
    createdOrderIds.push(order.id);

    const expected = calculatePricing({
      items: [{ unitPriceCents: ratePriceCents, quantity: qty }],
      fees: await loadFees(),
      promo: { discountType: 'PERCENT', discountValue: AUTO_PCT },
      tipCents: 0,
    });
    expect(expected.discountCents).toBeGreaterThan(0);
    expect(order.promo_code_id).toBe(autoPromoId);
    // Quote shown == amount charged: the server re-derived the discount, not the client.
    expect(order.discount_cents).toBe(expected.discountCents);
    expect(order.total_cents).toBe(expected.totalCents);

    // A ledger row was written keyed to this customer.
    const ledger = await adminPrisma.promoRedemption.count({
      where: { promo_code_id: autoPromoId, order_id: order.id },
    });
    expect(ledger).toBe(1);
  });

  it('rejects a customer who exceeds the promo per-customer limit', async () => {
    // First redemption succeeds (limit is 1 per customer).
    const slot1 = await makeSlot();
    const first = await createBooking(
      OP,
      {
        activityId,
        rateId,
        timeslotId: slot1,
        quantity: qty,
        customer: { first_name: 'Limit', last_name: 'Guest', email: LIMIT_EMAIL },
        participants: [],
        promoCode: LIMIT_CODE,
      },
      { channel: 'CUSTOMER' },
    );
    createdOrderIds.push(first.id);
    expect(first.promo_code_id).toBe(limitPromoId);

    const ledgerAfterFirst = await adminPrisma.promoRedemption.count({
      where: { promo_code_id: limitPromoId, customer_email: LIMIT_EMAIL },
    });
    expect(ledgerAfterFirst).toBe(1);

    // Second redemption by the SAME customer must be rejected.
    const slot2 = await makeSlot();
    await expect(
      createBooking(
        OP,
        {
          activityId,
          rateId,
          timeslotId: slot2,
          quantity: qty,
          customer: { first_name: 'Limit', last_name: 'Guest', email: LIMIT_EMAIL },
          participants: [],
          promoCode: LIMIT_CODE,
        },
        { channel: 'CUSTOMER' },
      ),
    ).rejects.toThrow(BookingError);

    // The counter never over-counted: still exactly one redemption for this customer.
    const ledgerAfterSecond = await adminPrisma.promoRedemption.count({
      where: { promo_code_id: limitPromoId, customer_email: LIMIT_EMAIL },
    });
    expect(ledgerAfterSecond).toBe(1);
  });
});
