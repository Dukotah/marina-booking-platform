/**
 * Payment provider seam — live HTTP integration test against the seeded LSRA
 * tenant, driving the real Hono app via `app.request(...)`. Proves the refactored
 * money path end to end through the PaymentProvider interface:
 *
 *   - GET  /api/payments/config       — the browser-facing provider config shape
 *   - POST /api/payments/charge       — straight success settles + zeroes balance
 *   - 3DS: a queued REQUIRES_ACTION outcome answers 200 `requiresAction` WITH
 *     `authentication.intentId` + `clientSecret` (the plumbing the old Stripe
 *     driver dropped — the sandbox driver proves it now flows through the route),
 *     then POST /confirm settles it identically to a straight success
 *   - POST /api/payments/:id/refund   — staff refund through the provider seam
 *   - POST /webhooks/stripe           — provider-dispatched webhook verification +
 *     normalization (refund totals sync, failure status, unknown events ignored)
 *
 * Runs entirely on the sandbox provider (the default in test env), which is the
 * point: the sandbox implements the SAME interface Stripe does, so green here
 * means the seam carries everything the routes need.
 *
 * SKIPS when DATABASE_URL is unset. Creates its own timeslots/orders/staff row and
 * deletes everything it made (including sandbox attempt + webhook rows) in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma, forOperator } from '@marina/database';
import { app } from '../src/app.js';
import { createBooking } from '../src/services/booking.js';
import { queueOutcome } from '../src/services/payments-sandbox.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';
const TEST_EMAIL = 'payments-seam-itest@example.com';

const publicJsonHeaders = { 'x-operator-slug': SLUG, 'content-type': 'application/json' };
const staffJsonHeaders = {
  'x-operator-slug': SLUG,
  'x-dev-staff-id': 'dev-owner',
  'content-type': 'application/json',
};

let activityId = '';
let rateId = '';
let qty = 1;
let slotCapacity = 1;
let createdStaff = false;
const createdOrderIds: string[] = [];
const createdTimeslotIds: string[] = [];

interface ChargeResponse {
  requiresAction?: boolean;
  payment: {
    id: string;
    status: string;
    amountCents: number;
    processorTransactionId: string | null;
  };
  order: { id: string; amountPaidCents: number; balanceDueCents: number };
  authentication?: {
    provider: string;
    intentId: string | null;
    clientSecret: string | null;
    returnUrl: string | null;
  };
}

describe.skipIf(!HAS_DB)('payment provider seam (live HTTP vs Postgres, LSRA seed)', () => {
  beforeAll(async () => {
    const existingStaff = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!existingStaff) {
      const loc = await adminPrisma.location.findFirst({
        where: { operator_id: OP },
        select: { id: true },
      });
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
    activityId = rate.activity_id;
    rateId = rate.id;
    qty = rate.activity.min_participants;
    slotCapacity = Math.max(rate.activity.max_participants, qty);

    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
  });

  afterAll(async () => {
    // Sandbox rows first: webhook rows chain to attempts, attempts to our orders.
    const attempts = await adminPrisma.sandboxPaymentAttempt.findMany({
      where: { operator_id: OP, order_id: { in: createdOrderIds } },
      select: { id: true },
    });
    const attemptIds = attempts.map((a) => a.id);
    await adminPrisma.sandboxWebhook.deleteMany({ where: { attempt_id: { in: attemptIds } } });
    await adminPrisma.sandboxPaymentAttempt.deleteMany({ where: { id: { in: attemptIds } } });
    for (const id of createdOrderIds) await adminPrisma.order.deleteMany({ where: { id } });
    for (const id of createdTimeslotIds) await adminPrisma.timeslot.deleteMany({ where: { id } });
    await adminPrisma.customer.deleteMany({ where: { operator_id: OP, email: TEST_EMAIL } });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({
        where: { operator_id: OP, auth_user_id: 'dev-owner' },
      });
    }
    await adminPrisma.$disconnect();
  });

  /** Book a fresh order (own timeslot) so tests never share capacity or balance. */
  async function bookOne() {
    const slot = await adminPrisma.timeslot.create({
      data: {
        operator_id: OP,
        activity_id: activityId,
        datetime: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
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
        customer: { first_name: 'Seam', last_name: 'Tester', email: TEST_EMAIL },
        participants: [],
      },
      { channel: 'CUSTOMER' },
    );
    createdOrderIds.push(order.id);
    return order;
  }

  it('GET /api/payments/config reports the sandbox provider with a sandbox client config', async () => {
    const res = await app.request('/api/payments/config', {
      headers: { 'x-operator-slug': SLUG },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provider: string;
      enabled: boolean;
      paymentMode: string;
      client: { kind: string };
    };
    // Test env runs the local simulator — the sandbox provider must win resolution.
    expect(body.provider).toBe('sandbox');
    expect(body.enabled).toBe(true);
    expect(body.client).toEqual({ kind: 'sandbox' });
    expect(['card', 'reserve']).toContain(body.paymentMode);
  });

  it('POST /charge settles a straight success through the provider and zeroes the balance', async () => {
    const order = await bookOne();
    expect(order.balance_due_cents).toBeGreaterThan(0);

    const res = await app.request('/api/payments/charge', {
      method: 'POST',
      headers: publicJsonHeaders,
      body: JSON.stringify({ orderId: order.id, sourceId: 'pm_seam_success' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ChargeResponse;
    expect(body.payment.status).toBe('PAID');
    expect(body.payment.amountCents).toBe(order.balance_due_cents);
    expect(body.order.balanceDueCents).toBe(0);
    // The provider's charge handle landed on the ledger row.
    expect(body.payment.processorTransactionId).toMatch(/^pi_sbx_/);
  });

  it('3DS: requires_action carries intentId + clientSecret through /charge, and /confirm settles it', async () => {
    const order = await bookOne();
    const db = forOperator(OP);
    await queueOutcome(db, OP, { outcome: 'REQUIRES_ACTION' });

    const res = await app.request('/api/payments/charge', {
      method: 'POST',
      headers: publicJsonHeaders,
      body: JSON.stringify({ orderId: order.id, sourceId: 'pm_seam_3ds' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChargeResponse;
    expect(body.requiresAction).toBe(true);
    expect(body.payment.status).toBe('REQUIRES_ACTION');

    // THE FIX under test: the challenge affordance is complete — intent id AND
    // client secret survive the trip through the provider seam and the route.
    expect(body.authentication).toBeDefined();
    expect(body.authentication!.provider).toBe('sandbox');
    expect(body.authentication!.intentId).toMatch(/^pi_sbx_/);
    expect(body.authentication!.clientSecret).toBeTruthy();
    expect(body.authentication!.clientSecret).toContain(body.authentication!.intentId!);
    expect(body.payment.processorTransactionId).toBe(body.authentication!.intentId);

    // No money moved yet.
    expect(body.order.balanceDueCents).toBe(order.balance_due_cents);

    // The guest authenticates — /confirm settles through the same provider and
    // records the charge exactly as a straight success would.
    const confirm = await app.request('/api/payments/confirm', {
      method: 'POST',
      headers: publicJsonHeaders,
      body: JSON.stringify({
        orderId: order.id,
        intentId: body.authentication!.intentId,
        action: 'complete',
      }),
    });
    expect(confirm.status).toBe(201);
    const settled = (await confirm.json()) as ChargeResponse;
    expect(settled.payment.status).toBe('PAID');
    expect(settled.order.balanceDueCents).toBe(0);
    expect(settled.payment.processorTransactionId).toBe(body.authentication!.intentId);
  });

  it('POST /:id/refund refunds a settled charge through the provider (staff)', async () => {
    const order = await bookOne();
    const charge = await app.request('/api/payments/charge', {
      method: 'POST',
      headers: publicJsonHeaders,
      body: JSON.stringify({ orderId: order.id, sourceId: 'pm_seam_refund' }),
    });
    expect(charge.status).toBe(201);
    const charged = (await charge.json()) as ChargeResponse;

    const refund = await app.request(`/api/payments/${charged.payment.id}/refund`, {
      method: 'POST',
      headers: staffJsonHeaders,
      body: JSON.stringify({ amountCents: 100, reason: 'seam test partial' }),
    });
    expect(refund.status).toBe(200);
    const body = (await refund.json()) as {
      refund: { id: string; status: string; amountCents: number };
      payment: { status: string; refundedCents: number };
    };
    expect(body.refund.status).toBe('succeeded');
    expect(body.refund.amountCents).toBe(100);
    expect(body.refund.id).toMatch(/^re_sbx_/);
    expect(body.payment.status).toBe('PARTIAL_REFUND');
    expect(body.payment.refundedCents).toBe(100);
  });

  describe('webhook dispatch (POST /webhooks/stripe via the provider)', () => {
    /** Charge a fresh order and return its Payment row. */
    async function chargedPayment() {
      const order = await bookOne();
      const res = await app.request('/api/payments/charge', {
        method: 'POST',
        headers: publicJsonHeaders,
        body: JSON.stringify({ orderId: order.id, sourceId: 'pm_seam_webhook' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as ChargeResponse;
      return {
        paymentId: body.payment.id,
        paymentRef: body.payment.processorTransactionId!,
        amountCents: body.payment.amountCents,
      };
    }

    /** A minimal provider-shaped event envelope (what the simulator emits). */
    function event(type: string, object: Record<string, unknown>) {
      return JSON.stringify({ id: `evt_seam_${Date.now()}`, type, data: { object } });
    }

    it('syncs cumulative refund totals from charge.refunded (partial then full)', async () => {
      const p = await chargedPayment();

      const partial = await app.request('/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: event('charge.refunded', { payment_intent: p.paymentRef, amount_refunded: 150 }),
      });
      expect(partial.status).toBe(200);
      let row = await adminPrisma.payment.findUnique({ where: { id: p.paymentId } });
      expect(row?.refunded_cents).toBe(150);
      expect(row?.status).toBe('PARTIAL_REFUND');

      const full = await app.request('/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: event('charge.refunded', {
          payment_intent: p.paymentRef,
          amount_refunded: p.amountCents,
        }),
      });
      expect(full.status).toBe(200);
      row = await adminPrisma.payment.findUnique({ where: { id: p.paymentId } });
      expect(row?.refunded_cents).toBe(p.amountCents);
      expect(row?.status).toBe('REFUNDED');
    });

    it('marks a payment FAILED on payment_intent.payment_failed', async () => {
      const p = await chargedPayment();
      const res = await app.request('/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: event('payment_intent.payment_failed', { id: p.paymentRef }),
      });
      expect(res.status).toBe(200);
      const row = await adminPrisma.payment.findUnique({ where: { id: p.paymentId } });
      expect(row?.status).toBe('FAILED');

      // …and payment_intent.succeeded restores PAID (the normalized counterpart).
      const back = await app.request('/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: event('payment_intent.succeeded', { id: p.paymentRef }),
      });
      expect(back.status).toBe(200);
      const restored = await adminPrisma.payment.findUnique({ where: { id: p.paymentId } });
      expect(restored?.status).toBe('PAID');
    });

    it('acknowledges unknown event types and unknown payment refs without retrying', async () => {
      const unknownType = await app.request('/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: event('customer.created', { id: 'cus_123' }),
      });
      expect(unknownType.status).toBe(200);
      expect(await unknownType.json()).toEqual({ ok: true });

      const unknownRef = await app.request('/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: event('payment_intent.succeeded', { id: 'pi_sbx_does_not_exist' }),
      });
      expect(unknownRef.status).toBe(200);
      expect(await unknownRef.json()).toEqual({ ok: true });
    });

    it('rejects an unparseable body with 400', async () => {
      const res = await app.request('/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json at all',
      });
      expect(res.status).toBe(400);
    });
  });
});
