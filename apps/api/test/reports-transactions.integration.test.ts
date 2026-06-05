/**
 * Accounting transactions export — live integration test against the seeded LSRA
 * tenant on Neon. This is the payment journal a bookkeeper imports into
 * QuickBooks/Xero, so we verify against real data that:
 *   - each Payment becomes a row keyed by processed_at, net of its own refunds
 *     (gross − refunded), with method/processor/order/customer attached;
 *   - the per-tender breakdown and totals are internally consistent with the rows
 *     (sums match), regardless of other tenant payments in range;
 *   - the endpoint is report:read-gated (200 staff / 401 without identity) and the
 *     CSV download carries the TOTAL reconciliation row.
 *
 * Creates one order with two payments (a partially-refunded CARD + a CASH) and
 * asserts on those specific payment ids. Skips without DATABASE_URL; cleans up.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { app } from '../src/app.js';
import { createBooking } from '../src/services/booking.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const HOUR = 60 * 60 * 1000;
const EMAIL = 'txn-itest@example.com';

let createdStaff = false;
let activityId = '';
let rateId = '';
let qty = 1;
let slotId = '';
let orderId = '';
let orderNumber = '';
let cardPaymentId = '';
let cashPaymentId = '';

describe.skipIf(!HAS_DB)('reports: accounting transactions export (live vs Neon, LSRA seed)', () => {
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
      select: { id: true, activity_id: true, activity: { select: { min_participants: true } } },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    rateId = rate.id;
    qty = rate.activity.min_participants;

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: EMAIL } });

    const slot = await forOperator(OP).timeslot.create({
      data: { operator_id: OP, activity_id: activityId, datetime: new Date(Date.now() + 2 * HOUR), capacity_total: 20, capacity_booked: 0, status: 'AVAILABLE' },
      select: { id: true },
    });
    slotId = slot.id;

    const order = await createBooking(
      OP,
      { activityId, rateId, timeslotId: slotId, quantity: qty, customer: { first_name: 'Txn', last_name: 'Tester', email: EMAIL }, participants: [] },
      { channel: 'CUSTOMER' },
    );
    orderId = order.id;
    orderNumber = order.order_number;

    const card = await forOperator(OP).payment.create({
      data: { operator_id: OP, order_id: orderId, method: 'CARD', status: 'PARTIAL_REFUND', amount_cents: 10_000, refunded_cents: 2_500, processor: 'STRIPE', card_brand: 'visa', card_last_four: '4242' },
      select: { id: true },
    });
    cardPaymentId = card.id;

    const cash = await forOperator(OP).payment.create({
      data: { operator_id: OP, order_id: orderId, method: 'CASH', status: 'PAID', amount_cents: 5_000, refunded_cents: 0 },
      select: { id: true },
    });
    cashPaymentId = cash.id;
  });

  afterAll(async () => {
    await adminPrisma.payment.deleteMany({ where: { id: { in: [cardPaymentId, cashPaymentId].filter(Boolean) } } });
    if (orderId) await adminPrisma.order.deleteMany({ where: { id: orderId } });
    if (slotId) await adminPrisma.timeslot.deleteMany({ where: { id: slotId } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: EMAIL } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({ where: { operator_id: OP, auth_user_id: 'dev-owner' } });
    }
    await adminPrisma.$disconnect();
  });

  it('emits a net-of-refunds row per payment, consistent with the breakdown + totals', async () => {
    const res = await app.request('/api/reports/transactions', {
      headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: {
        count: number;
        totalGrossCents: number;
        totalRefundedCents: number;
        totalNetCents: number;
        byMethod: Array<{ method: string; count: number; netCents: number }>;
        transactions: Array<{ paymentId: string; orderNumber: string; method: string; grossCents: number; refundedCents: number; netCents: number; processorTransactionId: string | null }>;
      };
    };
    const r = body.report;

    const card = r.transactions.find((t) => t.paymentId === cardPaymentId);
    expect(card).toBeDefined();
    expect(card!.method).toBe('CARD');
    expect(card!.orderNumber).toBe(orderNumber);
    expect(card!.grossCents).toBe(10_000);
    expect(card!.refundedCents).toBe(2_500);
    expect(card!.netCents).toBe(7_500); // net of its own refund

    const cash = r.transactions.find((t) => t.paymentId === cashPaymentId);
    expect(cash).toBeDefined();
    expect(cash!.method).toBe('CASH');
    expect(cash!.netCents).toBe(5_000);

    // Internal consistency holds regardless of other tenant payments in range.
    const rowNet = r.transactions.reduce((s, t) => s + t.netCents, 0);
    const methodNet = r.byMethod.reduce((s, m) => s + m.netCents, 0);
    expect(rowNet).toBe(r.totalNetCents);
    expect(methodNet).toBe(r.totalNetCents);
    expect(r.count).toBe(r.transactions.length);
    expect(r.totalNetCents).toBe(r.totalGrossCents - r.totalRefundedCents);
  });

  it('requires a staff identity (401 without the shim)', async () => {
    const res = await app.request('/api/reports/transactions', { headers: { 'x-operator-slug': SLUG } });
    expect(res.status).toBe(401);
  });

  it('CSV download carries the rows and the TOTAL reconciliation line', async () => {
    const res = await app.request('/api/reports/transactions.csv', {
      headers: { 'x-operator-slug': SLUG, 'x-dev-staff-id': 'dev-owner' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text).toContain(orderNumber);
    expect(text).toContain('TOTAL');
  });
});
