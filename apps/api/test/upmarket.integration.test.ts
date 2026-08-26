/**
 * Upmarket (Singenuity §1 #6) — live integration tests against the seeded Lake
 * Sonoma (LSRA) tenant. Proves, against a real database, that the booking money
 * path honours:
 *   - member pricing: a customer holding an ACTIVE membership is charged the
 *     member-discounted unit price, and a punch card decrements its uses;
 *   - dynamic pricing: an active PricingRule adjusts the effective unit price for
 *     the slot before fees are applied.
 *
 * SKIPS when DATABASE_URL is unset (so plain `pnpm test` stays green pre-DB). It
 * creates its own disposable membership / holding / pricing rule / timeslot /
 * customer and deletes everything it made in afterEach/afterAll, so it never
 * pollutes the seed tenant and is safe to re-run.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { applyMemberPrice, calculatePricing, type PricingFee } from '@marina/core';
import { createBooking } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const MEMBER_EMAIL = 'upmarket-member-itest@example.com';
const PLAIN_EMAIL = 'upmarket-plain-itest@example.com';

interface Fixture {
  activityId: string;
  rateId: string;
  ratePriceCents: number;
  minParticipants: number;
}

let fx: Fixture;
const createdOrderIds: string[] = [];
const createdSlotIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdPricingRuleIds: string[] = [];

async function loadFees(activityId: string): Promise<PricingFee[]> {
  const rows = await adminPrisma.fee.findMany({
    where: { operator_id: OP, enabled: true, OR: [{ activity_id: activityId }, { activity_id: null }] },
    select: { name: true, type: true, value: true },
  });
  return rows.map((f) => ({ name: f.name, type: f.type, value: f.value }));
}

/** A fresh, roomy future timeslot for the fixture activity (avoids capacity noise). */
async function makeSlot(datetime: Date): Promise<string> {
  const db = forOperator(OP);
  const slot = await db.timeslot.create({
    data: {
      operator_id: OP,
      activity_id: fx.activityId,
      datetime,
      capacity_total: 50,
      capacity_booked: 0,
      status: 'AVAILABLE',
    },
    select: { id: true },
  });
  createdSlotIds.push(slot.id);
  return slot.id;
}

describe.skipIf(!HAS_DB)('upmarket: member + dynamic pricing (live vs LSRA seed)', () => {
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
    if (!rate) throw new Error('No public rate in the LSRA seed — run `pnpm db:seed`.');

    await adminPrisma.customer.deleteMany({
      where: { operator_id: OP, email: { in: [MEMBER_EMAIL, PLAIN_EMAIL] } },
    });

    fx = {
      activityId: rate.activity_id,
      rateId: rate.id,
      ratePriceCents: rate.price_cents,
      minParticipants: rate.activity.min_participants,
    };
  });

  afterEach(async () => {
    for (const id of createdOrderIds.splice(0)) {
      await adminPrisma.order.deleteMany({ where: { id } });
    }
    for (const id of createdPricingRuleIds.splice(0)) {
      await adminPrisma.pricingRule.deleteMany({ where: { id } });
    }
  });

  afterAll(async () => {
    for (const id of createdSlotIds.splice(0)) {
      await adminPrisma.timeslot.deleteMany({ where: { id } });
    }
    // CustomerMembership rows cascade from Membership; delete memberships then customers.
    for (const id of createdMembershipIds.splice(0)) {
      await adminPrisma.membership.deleteMany({ where: { id } });
    }
    await adminPrisma.customer.deleteMany({
      where: { operator_id: OP, email: { in: [MEMBER_EMAIL, PLAIN_EMAIL] } },
    });
    await adminPrisma.$disconnect();
  });

  it('charges a member the discounted unit price and decrements a punch card', async () => {
    const db = forOperator(OP);

    // A 20%-off punch card with 5 launches.
    const membership = await db.membership.create({
      data: {
        operator_id: OP,
        name: 'ITest Punch Card',
        kind: 'PUNCH_CARD',
        is_active: true,
        discount_type: 'PERCENT',
        discount_value: 20,
        total_uses: 5,
      },
      select: { id: true },
    });
    createdMembershipIds.push(membership.id);

    // The member customer must exist before we can attach the holding; create it,
    // then grant the holding.
    const customer = await db.customer.create({
      data: { operator_id: OP, first_name: 'Member', last_name: 'Itest', email: MEMBER_EMAIL },
      select: { id: true },
    });
    await db.customerMembership.create({
      data: {
        operator_id: OP,
        membership_id: membership.id,
        customer_id: customer.id,
        status: 'ACTIVE',
        remaining_uses: 5,
      },
    });

    const slotId = await makeSlot(new Date(Date.now() + 20 * 86_400_000));
    const qty = fx.minParticipants;

    const order = await createBooking(
      OP,
      {
        activityId: fx.activityId,
        rateId: fx.rateId,
        timeslotId: slotId,
        quantity: qty,
        customer: { first_name: 'Member', last_name: 'Itest', email: MEMBER_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER', actor: 'upmarket.itest' },
    );
    createdOrderIds.push(order.id);

    const memberUnit = applyMemberPrice(fx.ratePriceCents, {
      discountType: 'PERCENT',
      discountValue: 20,
    });
    expect(memberUnit).toBeLessThan(fx.ratePriceCents);

    const expected = calculatePricing({
      items: [{ unitPriceCents: memberUnit, quantity: qty }],
      fees: await loadFees(fx.activityId),
      promo: null,
      tipCents: 0,
    });
    expect(order.subtotal_cents).toBe(expected.subtotalCents);
    expect(order.total_cents).toBe(expected.totalCents);
    expect(order.items[0]!.unit_price_cents).toBe(memberUnit);

    // The punch card lost `qty` uses.
    const holding = await adminPrisma.customerMembership.findFirst({
      where: { operator_id: OP, customer_id: customer.id },
      select: { remaining_uses: true },
    });
    expect(holding!.remaining_uses).toBe(5 - qty);
  });

  it('applies an active dynamic pricing rule to the effective unit price', async () => {
    const db = forOperator(OP);
    const slotDate = new Date(Date.now() + 25 * 86_400_000);
    const slotId = await makeSlot(slotDate);

    // A seasonal +$10 flat surcharge covering the slot date, scoped to this rate.
    const rule = await db.pricingRule.create({
      data: {
        operator_id: OP,
        name: 'ITest Seasonal Surcharge',
        kind: 'SEASONAL',
        adjustment_type: 'FLAT',
        adjustment_value: 1000,
        is_active: true,
        rate_id: fx.rateId,
        starts_on: new Date(Date.now() - 86_400_000),
        ends_on: new Date(Date.now() + 60 * 86_400_000),
      },
      select: { id: true },
    });
    createdPricingRuleIds.push(rule.id);

    const qty = fx.minParticipants;
    const order = await createBooking(
      OP,
      {
        activityId: fx.activityId,
        rateId: fx.rateId,
        timeslotId: slotId,
        quantity: qty,
        customer: { first_name: 'Plain', last_name: 'Itest', email: PLAIN_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER', actor: 'upmarket.itest' },
    );
    createdOrderIds.push(order.id);

    const surcharged = fx.ratePriceCents + 1000;
    const expected = calculatePricing({
      items: [{ unitPriceCents: surcharged, quantity: qty }],
      fees: await loadFees(fx.activityId),
      promo: null,
      tipCents: 0,
    });
    expect(order.items[0]!.unit_price_cents).toBe(surcharged);
    expect(order.total_cents).toBe(expected.totalCents);
  });
});
