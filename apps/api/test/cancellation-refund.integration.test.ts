/**
 * Tiered cancellation refund — live integration test against the seeded Lake
 * Sonoma (LSRA) tenant. Proves cancelBooking now resolves the effective
 * cancellation policy (Activity override -> Operator default -> safe full-refund
 * default), computes the tier from the booking's earliest start + now (+ guest
 * count), issues the card portion through the existing PaymentProvider refund
 * path, records the refund Payment + OrderEvent rows, rolls the order's
 * amount_paid / balance_due back, and is idempotent + race-safe.
 *
 * Each test builds a disposable activity + timeslot + order, charges a REAL
 * sandbox card payment so there is a processor transaction the provider can
 * refund, then cancels and asserts the money moved exactly as the tier dictates.
 * Every assertion FAILS before this feature was wired (cancelBooking used to
 * refund nothing and leave amount_paid untouched) and PASSES after.
 *
 * SKIPS without DATABASE_URL. Requires the sandbox processor (default in test).
 * Cleans up everything it created in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { cancelBooking, createBooking, BookingError } from '../src/services/booking.js';
import { getPaymentProvider } from '../src/services/payments/index.js';
import { issueGiftCard } from '../src/services/gift-cards.js';
import type { CancellationPolicy } from '@marina/core';

const HAS_DB = Boolean(process.env.DATABASE_URL);
// The refund path resolves + uses the (fake) processor — make sure it's on.
process.env.DEV_FAKE_PAYMENTS = 'true';

const OP = 'lsra';
const TEST_EMAIL = 'cancel-refund-itest@example.com';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A 3-tier policy: >=168h -> 100%, >=24h -> 50%, >=0h -> 0%.
const TIERED_POLICY: CancellationPolicy = {
  tiers: [
    { min_hours_before: 168, refund_percent: 100 },
    { min_hours_before: 24, refund_percent: 50 },
    { min_hours_before: 0, refund_percent: 0 },
  ],
  cancellation_fee_cents: 0,
  fee_scope: 'order',
  self_cancel_hours: 48,
  refund_method: 'card',
};

let activityId = '';
let rateId = '';
let unitPrice = 0;
let qty = 1;
let slotCapacity = 1;
// Snapshot of the activity's own policy so we can restore it after mutating.
let originalActivityPolicy: unknown = null;

const createdOrderIds: string[] = [];
const createdTimeslotIds: string[] = [];
const createdCardIds: string[] = [];

describe.skipIf(!HAS_DB)('tiered cancellation refund (live, LSRA seed)', () => {
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
    unitPrice = rate.price_cents;
    qty = rate.activity.min_participants;
    slotCapacity = Math.max(rate.activity.max_participants, qty);

    const activity = await adminPrisma.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: { cancellation_policy: true },
    });
    originalActivityPolicy = activity.cancellation_policy ?? null;

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
  });

  afterAll(async () => {
    // Restore the activity's original policy so we don't poison the seed.
    await adminPrisma.activity.update({
      where: { id: activityId },
      data: { cancellation_policy: originalActivityPolicy as never },
    });
    for (const id of createdOrderIds) await adminPrisma.order.deleteMany({ where: { id } });
    for (const id of createdTimeslotIds) await adminPrisma.timeslot.deleteMany({ where: { id } });
    for (const id of createdCardIds) await adminPrisma.giftCard.deleteMany({ where: { id } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    await adminPrisma.$disconnect();
  });

  /** Set the activity's cancellation policy (the override that wins resolution). */
  async function setActivityPolicy(policy: CancellationPolicy | null) {
    await adminPrisma.activity.update({
      where: { id: activityId },
      data: { cancellation_policy: policy as never },
    });
  }

  /**
   * Book a disposable order whose slot starts `hoursFromNow` out, then settle its
   * full total with a REAL sandbox card charge and write the matching PAID
   * Payment row (so the refund path has a processor transaction to reverse).
   * Returns the order id + what was paid.
   */
  async function bookAndPay(hoursFromNow: number): Promise<{ orderId: string; paidCents: number }> {
    const slot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + hoursFromNow * HOUR),
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
        customer: { first_name: 'Cancel', last_name: 'Refund', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'STAFF' },
    );
    createdOrderIds.push(order.id);

    const total = order.total_cents;

    // Real sandbox charge so the simulator's attempt ledger knows the intent and
    // can later refund it (a plain source id => straight success, no 3DS).
    const provider = await getPaymentProvider(OP);
    const charge = await provider.charge({
      orderId: order.id,
      tokenizedSource: `pm_cancel_${order.id}`,
      amountCents: total,
      idempotencyKey: `charge-${order.id}`,
      operatorId: OP,
    });
    if (charge.status !== 'succeeded') {
      throw new Error(`sandbox charge did not settle: ${charge.status}`);
    }

    const db = forOperator(OP);
    await db.payment.create({
      data: {
        operator_id: OP,
        order_id: order.id,
        method: 'CARD',
        status: 'PAID',
        amount_cents: total,
        processor: 'STRIPE',
        processor_transaction_id: charge.paymentRef,
        card_last_four: charge.cardLastFour,
        card_brand: charge.cardBrand,
      },
    });
    await db.order.update({
      where: { id: order.id },
      data: { amount_paid_cents: total, balance_due_cents: 0 },
    });

    return { orderId: order.id, paidCents: total };
  }

  /** The newest OrderEvent of a given type for an order. */
  async function latestEvent(orderId: string, type: string) {
    return adminPrisma.orderEvent.findFirst({
      where: { order_id: orderId, type },
      orderBy: { created_at: 'desc' },
    });
  }

  it('full-refund tier (>=168h out) refunds 100% to the card', async () => {
    await setActivityPolicy(TIERED_POLICY);
    const { orderId, paidCents } = await bookAndPay(10 * 24); // 240h out

    const cancelled = await cancelBooking(OP, orderId, { actor: 'staff', reason: 'test full' });
    const summary = (cancelled as { refundSummary?: unknown }).refundSummary as {
      tierPercent: number;
      refundCents: number;
      cardRefundCents: number;
    };

    expect(summary.tierPercent).toBe(100);
    expect(summary.refundCents).toBe(paidCents);
    expect(summary.cardRefundCents).toBe(paidCents);

    // Order ledger rolled fully back.
    const order = await adminPrisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.amount_paid_cents).toBe(0);
    expect(order.balance_due_cents).toBe(order.total_cents);
    expect(order.status).toBe('CANCELLED');

    // Card Payment marked fully refunded + a REFUND event recorded.
    const payment = await adminPrisma.payment.findFirstOrThrow({
      where: { order_id: orderId, method: 'CARD' },
    });
    expect(payment.refunded_cents).toBe(paidCents);
    expect(payment.status).toBe('REFUNDED');
    const refundEvent = await latestEvent(orderId, 'REFUND');
    expect(refundEvent).not.toBeNull();
  });

  it('partial tier (>=24h, <168h) refunds 50% to the card', async () => {
    await setActivityPolicy(TIERED_POLICY);
    const { orderId, paidCents } = await bookAndPay(72); // 72h out -> 50% tier

    const cancelled = await cancelBooking(OP, orderId, { actor: 'staff' });
    const summary = (cancelled as { refundSummary?: { refundCents: number; tierPercent: number } })
      .refundSummary!;

    const expected = Math.round(paidCents * 0.5);
    expect(summary.tierPercent).toBe(50);
    expect(summary.refundCents).toBe(expected);

    const order = await adminPrisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.amount_paid_cents).toBe(paidCents - expected);
    expect(order.balance_due_cents).toBe(order.total_cents - (paidCents - expected));
  });

  it('zero-refund tier (<24h out) keeps all the money and issues no refund', async () => {
    await setActivityPolicy(TIERED_POLICY);
    const { orderId, paidCents } = await bookAndPay(5); // 5h out -> 0% tier

    const cancelled = await cancelBooking(OP, orderId, { actor: 'staff' });
    const summary = (cancelled as { refundSummary?: { refundCents: number; tierPercent: number } })
      .refundSummary!;

    expect(summary.tierPercent).toBe(0);
    expect(summary.refundCents).toBe(0);

    // Money stays retained against the cancelled order.
    const order = await adminPrisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.amount_paid_cents).toBe(paidCents);
    expect(order.status).toBe('CANCELLED');

    const payment = await adminPrisma.payment.findFirstOrThrow({
      where: { order_id: orderId, method: 'CARD' },
    });
    expect(payment.refunded_cents).toBe(0);
    expect(payment.status).toBe('PAID');
  });

  it('missing policy (no activity + no operator policy) defaults to FULL refund', async () => {
    await setActivityPolicy(null);
    const op = await adminPrisma.operator.findUniqueOrThrow({
      where: { id: OP },
      select: { cancellation_policy: true },
    });
    const savedOperatorPolicy = op.cancellation_policy;
    await adminPrisma.operator.update({
      where: { id: OP },
      data: { cancellation_policy: null as never },
    });
    try {
      const { orderId, paidCents } = await bookAndPay(2); // 2h out — still full under default
      const cancelled = await cancelBooking(OP, orderId, { actor: 'staff' });
      const summary = (cancelled as { refundSummary?: { refundCents: number; tierPercent: number } })
        .refundSummary!;
      expect(summary.tierPercent).toBe(100);
      expect(summary.refundCents).toBe(paidCents);
    } finally {
      await adminPrisma.operator.update({
        where: { id: OP },
        data: { cancellation_policy: savedOperatorPolicy as never },
      });
    }
  });

  it('per-guest cancellation fee is multiplied by guest count', async () => {
    const perGuestFee = 500; // $5 withheld per guest
    const policy: CancellationPolicy = {
      ...TIERED_POLICY,
      cancellation_fee_cents: perGuestFee,
      fee_scope: 'guest',
    };
    await setActivityPolicy(policy);
    const { orderId, paidCents } = await bookAndPay(10 * 24); // full tier

    const cancelled = await cancelBooking(OP, orderId, { actor: 'staff' });
    const summary = (cancelled as {
      refundSummary?: { refundCents: number; feeCents: number };
    }).refundSummary!;

    // Gross is 100% of paid; fee = perGuestFee * qty guests, withheld.
    const expectedFee = perGuestFee * qty;
    expect(summary.feeCents).toBe(expectedFee);
    expect(summary.refundCents).toBe(paidCents - expectedFee);
  });

  it('already-cancelled order cannot be cancelled (or refunded) twice', async () => {
    await setActivityPolicy(TIERED_POLICY);
    const { orderId, paidCents } = await bookAndPay(10 * 24);

    await cancelBooking(OP, orderId, { actor: 'staff' });
    // Snapshot the refunded total after the first (idempotent) cancel.
    const afterFirst = await adminPrisma.payment.findFirstOrThrow({
      where: { order_id: orderId, method: 'CARD' },
    });
    expect(afterFirst.refunded_cents).toBe(paidCents);

    await expect(cancelBooking(OP, orderId, { actor: 'staff' })).rejects.toMatchObject({
      code: 'ALREADY_CANCELLED',
    });

    // The second attempt refunded nothing more — no double refund.
    const afterSecond = await adminPrisma.payment.findFirstOrThrow({
      where: { order_id: orderId, method: 'CARD' },
    });
    expect(afterSecond.refunded_cents).toBe(paidCents);
  });

  it('refund:false (declined/abandoned release) cancels without touching money', async () => {
    await setActivityPolicy(TIERED_POLICY);
    const { orderId, paidCents } = await bookAndPay(10 * 24);

    const cancelled = await cancelBooking(OP, orderId, {
      actor: 'system',
      reason: 'declined',
      refund: false,
    });
    expect((cancelled as { refundSummary?: unknown }).refundSummary).toBeNull();

    const payment = await adminPrisma.payment.findFirstOrThrow({
      where: { order_id: orderId, method: 'CARD' },
    });
    expect(payment.refunded_cents).toBe(0);
    const order = await adminPrisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.amount_paid_cents).toBe(paidCents); // untouched
  });

  it('already-started booking (start in the past) refunds 0 under a start-gated policy', async () => {
    await setActivityPolicy(TIERED_POLICY);
    // Book a future slot (so capacity + create succeed), then shove its start into
    // the past to model a departed trip. No tier >= negative hours qualifies -> 0%.
    const { orderId, paidCents } = await bookAndPay(48);
    const ts = createdTimeslotIds[createdTimeslotIds.length - 1];
    await adminPrisma.timeslot.update({
      where: { id: ts },
      data: { datetime: new Date(Date.now() - 3 * HOUR) },
    });

    const cancelled = await cancelBooking(OP, orderId, { actor: 'staff' });
    const summary = (cancelled as { refundSummary?: { refundCents: number; tierPercent: number } })
      .refundSummary!;
    expect(summary.tierPercent).toBe(0);
    expect(summary.refundCents).toBe(0);
    const order = await adminPrisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.amount_paid_cents).toBe(paidCents); // nothing refunded
  });

  it('STAFF cancel ignores the self-cancel window; CUSTOMER cancel inside the window is refused', async () => {
    await setActivityPolicy(TIERED_POLICY); // self_cancel_hours = 48
    const { orderId } = await bookAndPay(5); // 5h out — INSIDE the 48h cutoff

    // A customer self-cancel with enforcement on is refused (window closed).
    await expect(
      cancelBooking(OP, orderId, {
        actor: 'guest',
        channel: 'CUSTOMER',
        enforceSelfCancelWindow: true,
      }),
    ).rejects.toMatchObject({ code: 'SELF_CANCEL_WINDOW_CLOSED' });

    // The refused cancel changed nothing.
    const stillOpen = await adminPrisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(stillOpen.status).not.toBe('CANCELLED');

    // Staff cancel ignores the window and goes through (0% tier at 5h, so 0 refund).
    const cancelled = await cancelBooking(OP, orderId, { actor: 'staff', channel: 'STAFF' });
    expect((cancelled as { status: string }).status).toBe('CANCELLED');
  });

  it('partial payment refunds the tier percent of amount PAID, never the total', async () => {
    await setActivityPolicy(TIERED_POLICY);
    // Book, then pay only HALF the total (a deposit-style partial payment).
    const slot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 10 * DAY),
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
        customer: { first_name: 'Cancel', last_name: 'Partial', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'STAFF' },
    );
    createdOrderIds.push(order.id);

    const partial = Math.floor(order.total_cents / 2);
    const provider = await getPaymentProvider(OP);
    const charge = await provider.charge({
      orderId: order.id,
      tokenizedSource: `pm_partial_${order.id}`,
      amountCents: partial,
      idempotencyKey: `charge-partial-${order.id}`,
      operatorId: OP,
    });
    if (charge.status !== 'succeeded') throw new Error('partial charge did not settle');
    const db = forOperator(OP);
    await db.payment.create({
      data: {
        operator_id: OP,
        order_id: order.id,
        method: 'CARD',
        status: 'PAID',
        amount_cents: partial,
        processor: 'STRIPE',
        processor_transaction_id: charge.paymentRef,
      },
    });
    await db.order.update({
      where: { id: order.id },
      data: { amount_paid_cents: partial, balance_due_cents: order.total_cents - partial },
    });

    const cancelled = await cancelBooking(OP, order.id, { actor: 'staff' });
    const summary = (cancelled as { refundSummary?: { refundCents: number } }).refundSummary!;
    // Full tier (100%) of the amount PAID (the partial), not of the total.
    expect(summary.refundCents).toBe(partial);
    const reread = await adminPrisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reread.amount_paid_cents).toBe(0);
  });

  it('gift refund_method credits the gift card back instead of the card', async () => {
    const giftPolicy: CancellationPolicy = { ...TIERED_POLICY, refund_method: 'gift_card' };
    await setActivityPolicy(giftPolicy);

    // Book + pay with a GIFT_CARD Payment (no processor txn) so the refund must
    // route to gift credit.
    const slot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 10 * DAY),
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
        customer: { first_name: 'Cancel', last_name: 'Gift', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'STAFF' },
    );
    createdOrderIds.push(order.id);

    const total = order.total_cents;
    const card = await issueGiftCard(OP, { initialCents: total });
    createdCardIds.push(card.id);

    const db = forOperator(OP);
    // Model the redemption: card drained to 0, a GIFT_CARD Payment on the order.
    await db.giftCard.update({ where: { id: card.id }, data: { balance_cents: 0, status: 'REDEEMED' } });
    await db.payment.create({
      data: {
        operator_id: OP,
        order_id: order.id,
        method: 'GIFT_CARD',
        status: 'PAID',
        amount_cents: total,
        gift_card_id: card.id,
        processor: 'STRIPE',
      },
    });
    await db.order.update({
      where: { id: order.id },
      data: { amount_paid_cents: total, balance_due_cents: 0 },
    });

    const cancelled = await cancelBooking(OP, order.id, { actor: 'staff' });
    const summary = (cancelled as {
      refundSummary?: { cardRefundCents: number; giftRefundCents: number };
    }).refundSummary!;

    expect(summary.cardRefundCents).toBe(0);
    expect(summary.giftRefundCents).toBe(total);

    // Gift card balance restored + un-redeemed.
    const reread = await adminPrisma.giftCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(reread.balance_cents).toBe(total);
    expect(reread.status).toBe('ACTIVE');
  });
});
