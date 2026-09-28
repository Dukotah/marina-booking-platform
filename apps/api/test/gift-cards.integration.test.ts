/**
 * Gift cards — live integration test against the seeded LSRA tenant. Gift cards
 * move money, so we prove against real data that:
 *   - issuing creates an ACTIVE card with a unique code and full balance;
 *   - checkGiftCard reports validity + balance for public balance checks;
 *   - redeeming applies min(balance, requested, order balance due), records a
 *     GIFT_CARD Payment, decrements the card, and updates the order's paid/balance;
 *   - exhausting the balance flips the card to REDEEMED and it can't be reused;
 *   - a VOID card is rejected.
 *
 * Skips without DATABASE_URL. Cleans up everything it creates in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { cancelBooking, createBooking } from '../src/services/booking.js';
import {
  issueGiftCard,
  checkGiftCard,
  redeemGiftCard,
  getGiftCardByCode,
  giftCardLiabilityCents,
  GiftCardError,
} from '../src/services/gift-cards.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const TEST_EMAIL = 'giftcard-itest@example.com';

let activityId = '';
let rateId = '';
let qty = 1;
let slotCapacity = 1;
const createdOrderIds: string[] = [];
const createdCardIds: string[] = [];
const createdTimeslotIds: string[] = [];

describe.skipIf(!HAS_DB)('gift cards (live vs Neon, LSRA seed)', () => {
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
    activityId = rate.activity_id;
    rateId = rate.id;
    qty = rate.activity.min_participants;
    slotCapacity = Math.max(rate.activity.max_participants, qty);

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
  });

  afterAll(async () => {
    // Payments + order events cascade from the order; delete orders then cards.
    for (const id of createdOrderIds) await adminPrisma.order.deleteMany({ where: { id } });
    for (const id of createdCardIds) await adminPrisma.giftCard.deleteMany({ where: { id } });
    for (const id of createdTimeslotIds) await adminPrisma.timeslot.deleteMany({ where: { id } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  /** Each booking gets its own fresh timeslot so tests never exhaust shared capacity. */
  async function bookOne(email = TEST_EMAIL) {
    const slot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000),
        capacity_total: slotCapacity,
        capacity_booked: 0,
        status: 'AVAILABLE',
      },
      select: { id: true },
    });
    createdTimeslotIds.push(slot.id);
    const order = await createBooking(
      OP,
      {
        activityId,
        rateId,
        timeslotId: slot.id,
        quantity: qty,
        customer: { first_name: 'Gift', last_name: 'Tester', email },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    createdOrderIds.push(order.id);
    return order;
  }

  it('issues an ACTIVE card with a unique code and full balance', async () => {
    const card = await issueGiftCard(OP, { initialCents: 5000, purchaserEmail: TEST_EMAIL });
    createdCardIds.push(card.id);
    expect(card.status).toBe('ACTIVE');
    expect(card.balance_cents).toBe(5000);
    expect(card.initial_cents).toBe(5000);
    expect(card.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const check = await checkGiftCard(OP, card.code.toLowerCase()); // case-insensitive
    expect(check.valid).toBe(true);
    expect(check.balanceCents).toBe(5000);
  });

  it('redeems partial then exhausts, updating card + order correctly', async () => {
    const card = await issueGiftCard(OP, { initialCents: 5000 });
    createdCardIds.push(card.id);
    const order = await bookOne();
    const total = order.total_cents;
    expect(order.balance_due_cents).toBe(total);
    expect(total).toBeGreaterThan(3000); // seed rate is well over $30, so exhaust path holds

    // Partial: apply exactly 2000.
    const r1 = await redeemGiftCard(OP, { code: card.code, orderId: order.id, amountCents: 2000 });
    expect(r1.appliedCents).toBe(2000);
    expect(r1.cardBalanceCents).toBe(3000);
    expect(r1.cardStatus).toBe('ACTIVE');
    expect(r1.orderAmountPaidCents).toBe(2000);
    expect(r1.orderBalanceDueCents).toBe(total - 2000);

    // Exhaust: no amount → applies the remaining 3000 (order still owes more).
    const r2 = await redeemGiftCard(OP, { code: card.code, orderId: order.id });
    expect(r2.appliedCents).toBe(3000);
    expect(r2.cardBalanceCents).toBe(0);
    expect(r2.cardStatus).toBe('REDEEMED');
    expect(r2.orderAmountPaidCents).toBe(5000);
    expect(r2.orderBalanceDueCents).toBe(total - 5000);

    // A GIFT_CARD payment row exists for the card, summing to 5000.
    const paid = await adminPrisma.payment.aggregate({
      where: { operator_id: OP, gift_card_id: card.id, method: 'GIFT_CARD' },
      _sum: { amount_cents: true },
    });
    expect(paid._sum.amount_cents).toBe(5000);

    // Reused exhausted card is rejected.
    await expect(
      redeemGiftCard(OP, { code: card.code, orderId: order.id }),
    ).rejects.toThrow(GiftCardError);

    const reloaded = await getGiftCardByCode(OP, card.code);
    expect(reloaded!.status).toBe('REDEEMED');
    expect(reloaded!.balance_cents).toBe(0);
  });

  it('rejects a VOID card and never over-applies', async () => {
    const card = await issueGiftCard(OP, { initialCents: 4000 });
    createdCardIds.push(card.id);
    await adminPrisma.giftCard.update({ where: { id: card.id }, data: { status: 'VOID' } });
    const order = await bookOne();
    await expect(
      redeemGiftCard(OP, { code: card.code, orderId: order.id }),
    ).rejects.toThrow(GiftCardError);
    // Order untouched.
    const fresh = await adminPrisma.order.findUnique({ where: { id: order.id }, select: { amount_paid_cents: true } });
    expect(fresh!.amount_paid_cents).toBe(0);
  });

  it('reports outstanding gift-card liability from ACTIVE balances', async () => {
    const liability = await giftCardLiabilityCents(OP);
    expect(liability).toBeGreaterThanOrEqual(0);
  });

  it('refuses to redeem onto a CANCELLED order (money must not land on a dead booking)', async () => {
    // Red-team regression: cancel keeps balance_due as retained liability, so
    // without a status guard a public redeem drained a card into a cancelled
    // trip — and a gift-card Payment has no processor transaction to refund.
    const card = await issueGiftCard(OP, { initialCents: 5000 });
    const order = await bookOne();
    await cancelBooking(OP, order.id, { actor: 'test', reason: 'regression' });

    await expect(
      redeemGiftCard(OP, { code: card.code, orderId: order.id }),
    ).rejects.toMatchObject({ code: 'ORDER_CANCELLED' });

    // The card is untouched and still fully spendable.
    const check = await checkGiftCard(OP, card.code);
    expect(check.valid).toBe(true);
    expect(check.balanceCents).toBe(5000);
  });
});
