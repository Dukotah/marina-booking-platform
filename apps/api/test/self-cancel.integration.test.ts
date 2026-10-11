/**
 * Customer self-service cancel — live integration test against the seeded Lake
 * Sonoma (LSRA) tenant. Exercises the PUBLIC HTTP endpoints the account page drives:
 *
 *   GET  /api/orders/:orderNumber/self-cancel?email=  — refund preview
 *   POST /api/orders/:orderNumber/self-cancel         — the cancel itself
 *
 * Verifies, against real data:
 *   - the identity gate: a wrong/missing email 404s identically to a missing order
 *     (reused verbatim from self-reschedule, so no new IDOR surface), and the right
 *     email lets both the preview and the cancel through;
 *   - the self_cancel_hours cutoff: a booking whose start is inside the window is
 *     refused with 409 SELF_CANCEL_WINDOW_CLOSED (money untouched), while one far
 *     enough out is allowed;
 *   - the refund actually happens: a successful cancel issues the tiered card refund
 *     and rolls the order ledger back, with the refund surfaced on the response.
 *
 * SKIPS without DATABASE_URL. Uses the sandbox processor so there is a real
 * processor transaction to refund. Sets a disposable activity policy and restores
 * it; deletes everything it created in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { app } from '../src/app.js';
import { createBooking } from '../src/services/booking.js';
import { getPaymentProvider } from '../src/services/payments/index.js';
import type { CancellationPolicy } from '@marina/core';

const HAS_DB = Boolean(process.env.DATABASE_URL);
process.env.DEV_FAKE_PAYMENTS = 'true';

const OP = 'lsra';
const SLUG = 'lake-sonoma';
const EMAIL = 'self-cancel-itest@example.com';
const HOUR = 60 * 60 * 1000;

// Full refund >=168h out, 50% >=24h, 0% otherwise; self-cancel cutoff at 48h.
const POLICY: CancellationPolicy = {
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
let qty = 1;
let slotCapacity = 1;
let originalActivityPolicy: unknown = null;

const createdOrderIds: string[] = [];
const createdTimeslotIds: string[] = [];

async function bookAndPay(hoursFromNow: number): Promise<{
  orderId: string;
  orderNumber: string;
  paidCents: number;
}> {
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
      customer: { first_name: 'Self', last_name: 'Cancel', email: EMAIL },
      participants: [],
    },
    { channel: 'CUSTOMER' },
  );
  createdOrderIds.push(order.id);

  const total = order.total_cents;
  const provider = await getPaymentProvider(OP);
  const charge = await provider.charge({
    orderId: order.id,
    tokenizedSource: `pm_selfcancel_${order.id}`,
    amountCents: total,
    idempotencyKey: `charge-${order.id}`,
    operatorId: OP,
  });
  if (charge.status !== 'succeeded') throw new Error('sandbox charge did not settle');

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

  return { orderId: order.id, orderNumber: order.order_number, paidCents: total };
}

const H = { 'x-operator-slug': SLUG, 'content-type': 'application/json' } as const;

describe.skipIf(!HAS_DB)('self-service cancel (live HTTP, LSRA seed)', () => {
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

    const activity = await adminPrisma.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: { cancellation_policy: true },
    });
    originalActivityPolicy = activity.cancellation_policy ?? null;
    await adminPrisma.activity.update({
      where: { id: activityId },
      data: { cancellation_policy: POLICY as never },
    });

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: EMAIL } });
  });

  afterAll(async () => {
    await adminPrisma.activity.update({
      where: { id: activityId },
      data: { cancellation_policy: originalActivityPolicy as never },
    });
    for (const id of createdOrderIds) await adminPrisma.order.deleteMany({ where: { id } });
    for (const id of createdTimeslotIds) await adminPrisma.timeslot.deleteMany({ where: { id } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: EMAIL } });
    await adminPrisma.$disconnect();
  });

  it('preview GET 404s on a wrong email (identity gate — no probing)', async () => {
    const { orderNumber } = await bookAndPay(10 * 24);
    const res = await app.request(
      `/api/orders/${orderNumber}/self-cancel?email=${encodeURIComponent('not-the-booker@example.com')}`,
      { headers: { 'x-operator-slug': SLUG } },
    );
    expect(res.status).toBe(404);
  });

  it('preview GET returns the refund the cancel will produce (full tier)', async () => {
    const { orderNumber, paidCents } = await bookAndPay(10 * 24); // 240h out -> 100%
    const res = await app.request(
      `/api/orders/${orderNumber}/self-cancel?email=${encodeURIComponent(EMAIL)}`,
      { headers: { 'x-operator-slug': SLUG } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { preview: { refundCents: number; withinSelfCancelWindow: boolean; tierPercent: number } };
    expect(body.preview.tierPercent).toBe(100);
    expect(body.preview.refundCents).toBe(paidCents);
    expect(body.preview.withinSelfCancelWindow).toBe(true);
  });

  it('cancel POST 404s on a wrong email and leaves the order untouched', async () => {
    const { orderId, orderNumber } = await bookAndPay(10 * 24);
    const res = await app.request(`/api/orders/${orderNumber}/self-cancel`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ email: 'wrong@example.com' }),
    });
    expect(res.status).toBe(404);
    const order = await adminPrisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).not.toBe('CANCELLED');
  });

  it('cancel POST inside the self-cancel window is refused with 409 (money untouched)', async () => {
    const { orderId, orderNumber, paidCents } = await bookAndPay(5); // 5h out — inside 48h cutoff

    const res = await app.request(`/api/orders/${orderNumber}/self-cancel`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ email: EMAIL }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('SELF_CANCEL_WINDOW_CLOSED');

    // The refused cancel changed nothing — still upcoming, still fully paid.
    const order = await adminPrisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).not.toBe('CANCELLED');
    expect(order.amount_paid_cents).toBe(paidCents);
    const payment = await adminPrisma.payment.findFirstOrThrow({
      where: { order_id: orderId, method: 'CARD' },
    });
    expect(payment.refunded_cents).toBe(0);
  });

  it('cancel POST outside the window cancels AND issues the tiered refund', async () => {
    const { orderId, orderNumber, paidCents } = await bookAndPay(10 * 24); // 240h out -> full tier

    const res = await app.request(`/api/orders/${orderNumber}/self-cancel`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ email: EMAIL }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      order: { status: string };
      refund: { refundCents: number; cardRefundCents: number } | null;
    };
    expect(body.order.status).toBe('CANCELLED');
    expect(body.refund?.refundCents).toBe(paidCents);
    expect(body.refund?.cardRefundCents).toBe(paidCents);

    // Order ledger rolled back + card payment refunded on the DB.
    const order = await adminPrisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CANCELLED');
    expect(order.amount_paid_cents).toBe(0);
    const payment = await adminPrisma.payment.findFirstOrThrow({
      where: { order_id: orderId, method: 'CARD' },
    });
    expect(payment.refunded_cents).toBe(paidCents);
    expect(payment.status).toBe('REFUNDED');
  });
});
