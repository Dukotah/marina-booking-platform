/**
 * Gift card as tender — live integration test against the seeded LSRA tenant on
 * Neon. This is the money path that lets a gift card pay for a booking, so we verify
 * against real data that `POST /api/payments/gift-card`:
 *   - applies a partial amount: the order's balance_due drops, the card balance
 *     drops, a Payment{method:GIFT_CARD} is recorded, and a signed REDEEM ledger
 *     entry stamped with the order id is appended;
 *   - with no amount, applies as much as covers the remaining balance (settles the
 *     order to a zero balance, amount_paid == total);
 *   - refuses an amount larger than the order's outstanding balance (400);
 *   - refuses to apply to an already-settled order (400 NOTHING_DUE);
 *   - requires a staff identity (401 without the dev-staff shim);
 *   - refunds a GIFT_CARD payment back to the originating card (credits the card,
 *     appends a positive REFUND ledger entry, rolls the order back, and refuses a
 *     double refund).
 *
 * Skips without DATABASE_URL. Creates its own slot + booking + gift card and deletes
 * everything it made in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { app } from '../src/app.js';
import { createBooking } from '../src/services/booking.js';
import { issueGiftCard } from '../src/services/giftcards.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const EMAIL = 'gctender-itest@example.com';
const DAY = 24 * 60 * 60 * 1000;

const staffHeaders = {
  'x-operator-slug': SLUG,
  'x-dev-staff-id': 'dev-owner',
  'content-type': 'application/json',
};

let slotId = '';
let orderId = '';
let totalCents = 0;
let balanceDue = 0;
let cardCode = '';
let cardId = '';
let createdStaff = false;

describe.skipIf(!HAS_DB)('gift card as tender (live HTTP vs Neon, LSRA seed)', () => {
  beforeAll(async () => {
    const existingStaff = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!existingStaff) {
      const loc = await adminPrisma.location.findFirst({ where: { operator_id: OP }, select: { id: true } });
      await adminPrisma.staffMember.create({
        data: {
          operator_id: OP,
          auth_user_id: 'dev-owner',
          name: 'Dev Owner',
          email: 'dev-owner@example.com',
          role: 'OWNER',
          is_active: true,
          locations: loc ? { create: { location_id: loc.id } } : undefined,
        },
      });
      createdStaff = true;
    }

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
        datetime: new Date(Date.now() + 40 * DAY),
        capacity_total: rate.activity.max_participants,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    slotId = slot.id;

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: EMAIL } });

    const order = await createBooking(
      OP,
      {
        activityId: rate.activity_id,
        rateId: rate.id,
        timeslotId: slotId,
        quantity: rate.activity.min_participants,
        customer: { first_name: 'GC', last_name: 'Tender', email: EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    orderId = order.id;
    totalCents = order.total_cents;
    balanceDue = order.balance_due_cents;
    expect(balanceDue).toBeGreaterThan(0); // unpaid on creation

    // Issue a card with more than enough to cover the order (so we can partial + settle).
    const card = await issueGiftCard(OP, { amountCents: balanceDue + 5_000 }, { actor: 'itest' });
    cardId = card.id;
    cardCode = card.code;
  });

  afterAll(async () => {
    if (orderId) await adminPrisma.order.deleteMany({ where: { id: orderId } }); // cascades payments/events/items
    if (cardId) await adminPrisma.giftCard.deleteMany({ where: { id: cardId } }); // cascades transactions
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: EMAIL } });
    if (slotId) await adminPrisma.timeslot.deleteMany({ where: { id: slotId } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
    await adminPrisma.$disconnect();
  });

  it('requires a staff identity (401 without the shim)', async () => {
    const res = await app.request('/api/payments/gift-card', {
      method: 'POST',
      headers: { 'x-operator-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ orderId, code: cardCode, amountCents: 100 }),
    });
    expect(res.status).toBe(401);
  });

  it('applies a partial amount: order balance + card balance drop, Payment + ledger recorded', async () => {
    const apply = 1_000;
    const res = await app.request('/api/payments/gift-card', {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ orderId, code: cardCode, amountCents: apply }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: { method: string; amountCents: number };
      order: { amountPaidCents: number; balanceDueCents: number };
      giftCard: { balanceCents: number };
    };
    expect(body.payment.method).toBe('GIFT_CARD');
    expect(body.payment.amountCents).toBe(apply);
    expect(body.order.amountPaidCents).toBe(apply);
    expect(body.order.balanceDueCents).toBe(balanceDue - apply);
    expect(body.giftCard.balanceCents).toBe(balanceDue + 5_000 - apply);

    // A GIFT_CARD payment row is persisted on the order.
    const payment = await adminPrisma.payment.findFirst({
      where: { order_id: orderId, method: 'GIFT_CARD' },
    });
    expect(payment!.amount_cents).toBe(apply);

    // A signed REDEEM ledger entry stamped with the order id.
    const redeem = await adminPrisma.giftCardTransaction.findFirst({
      where: { gift_card_id: cardId, type: 'REDEEM', order_id: orderId },
      orderBy: { created_at: 'desc' },
    });
    expect(redeem!.amount_cents).toBe(-apply);
    expect(redeem!.order_id).toBe(orderId);
  });

  it('refuses an amount larger than the outstanding balance (400)', async () => {
    // Remaining due is balanceDue - 1000; requesting the full original total exceeds it.
    const res = await app.request('/api/payments/gift-card', {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ orderId, code: cardCode, amountCents: balanceDue }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('EXCEEDS_BALANCE_DUE');
  });

  it('with no amount, settles the remaining balance to zero', async () => {
    const res = await app.request('/api/payments/gift-card', {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ orderId, code: cardCode }), // no amountCents
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      order: { amountPaidCents: number; balanceDueCents: number };
    };
    expect(body.order.balanceDueCents).toBe(0);
    expect(body.order.amountPaidCents).toBe(totalCents);

    const order = await adminPrisma.order.findUnique({ where: { id: orderId } });
    expect(order!.balance_due_cents).toBe(0);
    expect(order!.amount_paid_cents).toBe(totalCents);
  });

  it('refuses to apply to an already-settled order (400 NOTHING_DUE)', async () => {
    const res = await app.request('/api/payments/gift-card', {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({ orderId, code: cardCode, amountCents: 100 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOTHING_DUE');
  });

  it('refunds a gift-card payment back to the originating card (and rolls the order back)', async () => {
    // The partial 1,000-cent gift-card payment recorded earlier in the run.
    const payment = await adminPrisma.payment.findFirst({
      where: { order_id: orderId, method: 'GIFT_CARD', amount_cents: 1_000 },
    });
    expect(payment).toBeTruthy();
    const cardBefore = await adminPrisma.giftCard.findUnique({ where: { id: cardId } });
    const orderBefore = await adminPrisma.order.findUnique({ where: { id: orderId } });

    const res = await app.request(`/api/payments/${payment!.id}/refund`, {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({}), // full refund of this payment
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      refund: { amountCents: number; giftCardBalanceCents: number };
      payment: { status: string; refundedCents: number };
      order: { amountPaidCents: number; balanceDueCents: number };
    };
    expect(body.refund.amountCents).toBe(1_000);
    expect(body.payment.status).toBe('REFUNDED');
    expect(body.payment.refundedCents).toBe(1_000);
    // Card credited back; order amount_paid rolled back by the same amount.
    expect(body.refund.giftCardBalanceCents).toBe(cardBefore!.balance_cents + 1_000);
    expect(body.order.amountPaidCents).toBe(orderBefore!.amount_paid_cents - 1_000);

    // A positive REFUND ledger entry stamped with the order id.
    const refundTxn = await adminPrisma.giftCardTransaction.findFirst({
      where: { gift_card_id: cardId, type: 'REFUND', order_id: orderId },
      orderBy: { created_at: 'desc' },
    });
    expect(refundTxn!.amount_cents).toBe(1_000);
    expect(refundTxn!.balance_after_cents).toBe(cardBefore!.balance_cents + 1_000);

    // Refunding the same payment again is refused.
    const again = await app.request(`/api/payments/${payment!.id}/refund`, {
      method: 'POST',
      headers: staffHeaders,
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(400);
    const againBody = (await again.json()) as { code: string };
    expect(againBody.code).toBe('ALREADY_REFUNDED');
  });
});
