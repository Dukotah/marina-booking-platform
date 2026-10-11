/**
 * Double-payment TOCTOU regression (conc-03) — live integration test against the
 * seeded Lake Sonoma (LSRA) tenant. Fires collectBalance (CARD) and redeemGiftCard
 * in parallel at the SAME order whose full total is due, and proves the Order-row
 * FOR UPDATE lock in both services serialises them: exactly ONE payer collects the
 * balance, the other is cleanly refused, and the ledger lands consistent.
 *
 * Without the lock both transactions read balance_due_cents under READ COMMITTED,
 * both write balance_due=0 last-writer-wins, and the order is paid TWICE — a card
 * charge AND a gift-card drain against one balance, with the gift-card Payment
 * un-refundable (no processor txn). This test reproduces that: pre-fix, payments
 * sum to 2x the balance; post-fix they sum to exactly the balance.
 *
 * SKIPS when DATABASE_URL is unset. Requires DEV_FAKE_PAYMENTS=true (simulated
 * processor). Creates its own disposable slot/order/card and cleans up in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import { createBooking, collectBalance } from '../src/services/booking.js';
import { issueGiftCard, redeemGiftCard } from '../src/services/gift-cards.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
// The balance-collection path charges via the (fake) processor — force it on.
process.env.DEV_FAKE_PAYMENTS = 'true';

const OP = 'lsra';
const TEST_EMAIL = 'pay-twice-race-itest@example.com';

let activityId = '';
let rateId = '';
let qty = 1;
let slotCapacity = 1;
const createdOrderIds: string[] = [];
const createdCardIds: string[] = [];
const createdTimeslotIds: string[] = [];

describe.skipIf(!HAS_DB)('pay-twice race: collectBalance vs redeemGiftCard (live, LSRA seed)', () => {
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
    for (const id of createdOrderIds) await adminPrisma.order.deleteMany({ where: { id } });
    for (const id of createdCardIds) await adminPrisma.giftCard.deleteMany({ where: { id } });
    for (const id of createdTimeslotIds) await adminPrisma.timeslot.deleteMany({ where: { id } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  async function bookOne() {
    const slot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 37 * 24 * 60 * 60 * 1000),
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
        customer: { first_name: 'Race', last_name: 'Payer', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    createdOrderIds.push(order.id);
    return order;
  }

  it('serialises a card collect and a gift-card redeem on the same balance: paid once, not twice', async () => {
    const order = await bookOne();
    const total = order.total_cents;
    expect(order.balance_due_cents).toBe(total);

    // A gift card big enough to cover the whole balance by itself, so the only
    // thing stopping a double-pay is the Order row lock (not an exhausted card).
    const card = await issueGiftCard(OP, { initialCents: total + 1000 });
    createdCardIds.push(card.id);

    // Both payers target the same full balance at once.
    const results = await Promise.allSettled([
      collectBalance(OP, order.id, { actor: 'pay-twice.test', method: 'CARD' }),
      redeemGiftCard(OP, { code: card.code, orderId: order.id }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one payer collected the balance; the other was cleanly refused
    // (NO_BALANCE_DUE from collectBalance or NOTHING_TO_APPLY from the redeem),
    // not a crash or deadlock.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    expect(['NO_BALANCE_DUE', 'NOTHING_TO_APPLY']).toContain(err.code);

    // The ledger is paid exactly once: amount_paid == total, balance == 0.
    const fresh = await adminPrisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { amount_paid_cents: true, balance_due_cents: true, total_cents: true },
    });
    expect(fresh.balance_due_cents).toBe(0);
    expect(fresh.amount_paid_cents).toBe(total);

    // And the PAID payments sum to exactly the balance — never 2x (the double-pay).
    const paid = await adminPrisma.payment.aggregate({
      where: { operator_id: OP, order_id: order.id, status: 'PAID' },
      _sum: { amount_cents: true },
    });
    expect(paid._sum.amount_cents).toBe(total);
  });
});
