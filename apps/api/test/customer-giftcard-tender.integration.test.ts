/**
 * Customer self-service gift-card tender — live integration test against the seeded
 * LSRA tenant on Neon. Verifies `POST /api/payments/customer/gift-card`:
 *   - requires a customer session token (401 without one);
 *   - lets the authenticated customer pay down THEIR OWN order (balance + card drop,
 *     a GIFT_CARD Payment is recorded);
 *   - refuses a token whose email doesn't own the order (404, balance unchanged) —
 *     so one customer can't spend a card against another's booking.
 *
 * Tokens are minted directly via issueCustomerToken (the OTP HTTP dance is covered by
 * customer-auth.integration.test.ts). Skips without DATABASE_URL; cleans up after itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { app } from '../src/app.js';
import { createBooking } from '../src/services/booking.js';
import { issueGiftCard } from '../src/services/giftcards.js';
import { issueCustomerToken } from '../src/services/customer-auth.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const OWNER_EMAIL = 'cust-gc-owner-itest@example.com';
const OTHER_EMAIL = 'cust-gc-other-itest@example.com';
const DAY = 24 * 60 * 60 * 1000;

let slotId = '';
let orderId = '';
let balanceDue = 0;
let cardCode = '';
let cardId = '';
let ownerToken = '';
let otherToken = '';

describe.skipIf(!HAS_DB)('customer gift-card tender (live HTTP vs Neon, LSRA seed)', () => {
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
        activity_id: true,
        activity: { select: { min_participants: true, max_participants: true } },
      },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');

    const slot = await forOperator(OP).timeslot.create({
      data: {
        operator_id: OP,
        activity_id: rate.activity_id,
        datetime: new Date(Date.now() + 55 * DAY),
        capacity_total: rate.activity.max_participants,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    slotId = slot.id;

    await adminPrisma.customer.deleteMany({
      where: { operator_id: OP, email: { in: [OWNER_EMAIL, OTHER_EMAIL] } },
    });

    const order = await createBooking(
      OP,
      {
        activityId: rate.activity_id,
        rateId: rate.id,
        timeslotId: slotId,
        quantity: rate.activity.min_participants,
        customer: { first_name: 'Card', last_name: 'Owner', email: OWNER_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    orderId = order.id;
    balanceDue = order.balance_due_cents;

    const card = await issueGiftCard(OP, { amountCents: balanceDue + 5_000 }, { actor: 'itest' });
    cardId = card.id;
    cardCode = card.code;

    // The order's customer id is resolved by the auth flow; here we mint tokens directly.
    const customer = await adminPrisma.customer.findFirst({
      where: { operator_id: OP, email: OWNER_EMAIL },
      select: { id: true },
    });
    ownerToken = await issueCustomerToken(OP, OWNER_EMAIL, customer?.id ?? null);
    otherToken = await issueCustomerToken(OP, OTHER_EMAIL, null);
  });

  afterAll(async () => {
    if (orderId) await adminPrisma.order.deleteMany({ where: { id: orderId } });
    if (cardId) await adminPrisma.giftCard.deleteMany({ where: { id: cardId } });
    await adminPrisma.customer.deleteMany({
      where: { operator_id: OP, email: { in: [OWNER_EMAIL, OTHER_EMAIL] } },
    });
    if (slotId) await adminPrisma.timeslot.deleteMany({ where: { id: slotId } });
    await adminPrisma.$disconnect();
  });

  it('requires a customer token (401 without one)', async () => {
    const res = await app.request('/api/payments/customer/gift-card', {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ orderId, code: cardCode, amountCents: 500 }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a token whose email does not own the order (404, balance unchanged)", async () => {
    const res = await app.request('/api/payments/customer/gift-card', {
      method: 'POST',
      headers: {
        'x-operator-slug': SLUG,
        'content-type': 'application/json',
        authorization: `Bearer ${otherToken}`,
      },
      body: JSON.stringify({ orderId, code: cardCode, amountCents: 500 }),
    });
    expect(res.status).toBe(404);
    const order = await adminPrisma.order.findUnique({ where: { id: orderId } });
    expect(order!.amount_paid_cents).toBe(0); // untouched
  });

  it('lets the owner pay down their own order with a gift card', async () => {
    const apply = 1_500;
    const res = await app.request('/api/payments/customer/gift-card', {
      method: 'POST',
      headers: {
        'x-operator-slug': SLUG,
        'content-type': 'application/json',
        authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ orderId, code: cardCode, amountCents: apply }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: { method: string; amountCents: number };
      order: { amountPaidCents: number; balanceDueCents: number };
      giftCard: { balanceCents: number };
    };
    expect(body.payment.method).toBe('GIFT_CARD');
    expect(body.order.amountPaidCents).toBe(apply);
    expect(body.order.balanceDueCents).toBe(balanceDue - apply);
    expect(body.giftCard.balanceCents).toBe(balanceDue + 5_000 - apply);

    const payment = await adminPrisma.payment.findFirst({
      where: { order_id: orderId, method: 'GIFT_CARD' },
    });
    expect(payment!.amount_cents).toBe(apply);
    // The ledger entry is attributed to the customer actor.
    const txn = await adminPrisma.giftCardTransaction.findFirst({
      where: { gift_card_id: cardId, type: 'REDEEM', order_id: orderId },
      orderBy: { created_at: 'desc' },
    });
    expect(txn!.actor).toBe(`customer:${OWNER_EMAIL}`);
  });
});
