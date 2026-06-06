/**
 * Payments API — charge a booking and refund it (Stripe, test-first).
 *
 *   POST /api/payments/charge        public  — charge a card against an order
 *   POST /api/payments/:id/refund    staff   — full/partial refund (order:refund)
 *
 * All money is integer cents. Every DB write is tenant-scoped (RLS via c.var.db)
 * and the multi-row mutations run inside a single tenant transaction so an order's
 * balance and its payment row can never drift. Stripe's network call happens
 * BEFORE the transaction (you don't want to hold a DB tx open across an external
 * HTTP call); the transaction then records the already-settled result.
 *
 * If Stripe isn't configured, every endpoint returns a clean 501 instead of
 * crashing — payments are an opt-in integration.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import { withTenant } from '@marina/database';
import { createId } from '@marina/core';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import {
  createPayment,
  confirmPaymentIntent,
  refundPayment,
  isStripeConfigured,
  StripeNotConfiguredError,
  StripePaymentError,
  type StripePaymentSucceeded,
} from '../services/stripe.js';

export const payments = new Hono<Env>();

const chargeSchema = z.object({
  orderId: z.string().min(1),
  /** Stripe PaymentMethod id created client-side by Stripe.js / Elements. */
  sourceId: z.string().min(1),
  /** Amount to charge, integer cents. Defaults to the order's full balance. */
  amountCents: z.number().int().positive().optional(),
  /** Client-supplied key to make retries safe; generated if absent. */
  idempotencyKey: z.string().min(1).max(45).optional(),
});

const confirmSchema = z.object({
  /** The order the PaymentIntent belongs to (so we can attach the Payment row). */
  orderId: z.string().min(1),
  /** The Stripe PaymentIntent id the browser just completed the 3DS challenge on. */
  paymentIntentId: z.string().min(1),
});

const refundSchema = z.object({
  /** Amount to refund, integer cents. Defaults to the full remaining refundable. */
  amountCents: z.number().int().positive().optional(),
  reason: z.string().max(192).optional(),
});

/**
 * Record a settled Stripe charge against an order in one tenant transaction:
 * create the Payment row, advance amount_paid / balance_due, and log an
 * OrderEvent. Shared by the synchronous /charge success path and the post-3DS
 * /confirm finalize path so both persist identical data.
 *
 * IDEMPOTENT: if a Payment already exists for this PaymentIntent
 * (processor_transaction_id) we do NOT insert again or touch the balance — we
 * return the existing row. This makes /confirm safe to call more than once and
 * keeps it from racing the payment_intent.succeeded webhook into a double charge.
 */
async function recordSettledPayment(
  c: Context<Env>,
  order: { id: string; total_cents: number; amount_paid_cents: number },
  amountCents: number,
  result: StripePaymentSucceeded,
): Promise<{
  payment: {
    id: string;
    status: string;
    amount_cents: number;
    card_brand: string | null;
    card_last_four: string | null;
    processor_transaction_id: string | null;
  };
  amountPaidCents: number;
  balanceDueCents: number;
  alreadyRecorded: boolean;
}> {
  return withTenant(c.var.operatorId, async (tx) => {
    // Idempotency guard: never double-insert for the same PaymentIntent.
    const existing = await tx.payment.findFirst({
      where: { processor_transaction_id: result.paymentId, processor: 'STRIPE' },
    });
    if (existing) {
      const current = await tx.order.findUnique({ where: { id: order.id } });
      return {
        payment: existing,
        amountPaidCents: current?.amount_paid_cents ?? order.amount_paid_cents,
        balanceDueCents:
          current?.balance_due_cents ?? order.total_cents - order.amount_paid_cents,
        alreadyRecorded: true,
      };
    }

    const newAmountPaid = order.amount_paid_cents + amountCents;
    const newBalanceDue = order.total_cents - newAmountPaid;

    const created = await tx.payment.create({
      data: {
        id: createId(),
        operator_id: c.var.operatorId,
        order_id: order.id,
        method: 'CARD',
        status: 'PAID',
        amount_cents: amountCents,
        card_brand: result.cardBrand,
        card_last_four: result.cardLastFour,
        cardholder_name: result.cardholderName,
        processor: 'STRIPE',
        processor_transaction_id: result.paymentId,
      },
    });

    await tx.order.update({
      where: { id: order.id },
      data: {
        amount_paid_cents: newAmountPaid,
        balance_due_cents: newBalanceDue,
      },
    });

    await tx.orderEvent.create({
      data: {
        id: createId(),
        operator_id: c.var.operatorId,
        order_id: order.id,
        type: 'PAYMENT',
        description: `Charged card ending ${result.cardLastFour ?? '????'}`,
        actor: 'customer',
        metadata: {
          paymentId: created.id,
          processorTransactionId: result.paymentId,
          amountCents,
          receiptUrl: result.receiptUrl,
        },
      },
    });

    return {
      payment: created,
      amountPaidCents: newAmountPaid,
      balanceDueCents: newBalanceDue,
      alreadyRecorded: false,
    };
  });
}

/** Map a Stripe service error to a clean JSON response. */
function stripeErrorResponse(c: Context<Env>, err: unknown) {
  if (err instanceof StripeNotConfiguredError) {
    return c.json({ error: 'payments not configured' }, 501);
  }
  if (err instanceof StripePaymentError) {
    return c.json(
      { error: err.message, code: err.code ?? null },
      err.status as ContentfulStatusCode,
    );
  }
  throw err; // unexpected — let the central error handler 500 it
}

/**
 * POST /api/payments/charge — public. Charges a card via Stripe, records a
 * Payment row, advances the order's amount_paid / balance_due, and logs an
 * OrderEvent. Public because customers pay during checkout (no staff session).
 */
payments.post('/charge', async (c) => {
  if (!isStripeConfigured()) {
    return c.json({ error: 'payments not configured' }, 501);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = chargeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  const { orderId, sourceId } = parsed.data;

  // Load the order (RLS-scoped) to determine how much to charge and to validate.
  const order = await c.var.db.order.findUnique({ where: { id: orderId } });
  if (!order) {
    return c.json({ error: 'Order not found' }, 404);
  }

  const amountCents = parsed.data.amountCents ?? order.balance_due_cents;
  if (amountCents <= 0) {
    return c.json({ error: 'Nothing to charge — order has no outstanding balance' }, 400);
  }
  if (amountCents > order.balance_due_cents) {
    return c.json(
      { error: 'Charge exceeds the outstanding balance', balanceDueCents: order.balance_due_cents },
      400,
    );
  }

  // Charge Stripe OUTSIDE the DB transaction (external network call).
  let result;
  try {
    result = await createPayment({
      orderId: order.id,
      sourceId,
      amountCents,
      idempotencyKey: parsed.data.idempotencyKey ?? createId(),
    });
  } catch (err) {
    return stripeErrorResponse(c, err);
  }

  // 3-D Secure / SCA: the card needs a browser challenge before it can settle. Do
  // NOT record a Payment row yet (nothing is captured). Respond 200 with the
  // client secret; the browser runs handleNextAction then calls POST /confirm to
  // finalize. See the 3DS sequence comment in apps/web/.../PaymentSection / actions.
  if (result.kind === 'requires_action') {
    return c.json(
      {
        status: 'REQUIRES_ACTION',
        clientSecret: result.clientSecret,
        paymentIntentId: result.paymentIntentId,
      },
      200,
    );
  }

  // Settled outright — record the charge atomically against the order.
  const recorded = await recordSettledPayment(c, order, amountCents, result);

  return c.json(
    {
      payment: {
        id: recorded.payment.id,
        status: recorded.payment.status,
        amountCents: recorded.payment.amount_cents,
        cardBrand: recorded.payment.card_brand,
        cardLastFour: recorded.payment.card_last_four,
        processorTransactionId: recorded.payment.processor_transaction_id,
        receiptUrl: result.receiptUrl,
      },
      order: {
        id: order.id,
        amountPaidCents: recorded.amountPaidCents,
        balanceDueCents: recorded.balanceDueCents,
      },
    },
    201,
  );
});

/**
 * POST /api/payments/confirm — public. Post-3DS finalize step.
 *
 * After the browser completes the 3-D Secure / SCA challenge (via Stripe.js
 * handleNextAction on the client secret returned by /charge), it calls this to
 * settle the booking. We retrieve the authoritative PaymentIntent state from
 * Stripe:
 *   - `succeeded`        → record the Payment row (idempotently — see
 *                          recordSettledPayment) and return it like /charge does,
 *   - `requires_action`  → still pending; return REQUIRES_ACTION again,
 *   - otherwise          → treated as a decline (Stripe error response).
 */
payments.post('/confirm', async (c) => {
  if (!isStripeConfigured()) {
    return c.json({ error: 'payments not configured' }, 501);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  const { orderId, paymentIntentId } = parsed.data;

  const order = await c.var.db.order.findUnique({ where: { id: orderId } });
  if (!order) {
    return c.json({ error: 'Order not found' }, 404);
  }

  // Retrieve the PaymentIntent's authoritative state after the browser challenge.
  let result;
  try {
    result = await confirmPaymentIntent({
      paymentIntentId,
      // The intent's own amount_received is the source of truth on success; this
      // is only a fallback if Stripe omits it.
      fallbackAmountCents: order.balance_due_cents,
    });
  } catch (err) {
    return stripeErrorResponse(c, err);
  }

  // Still mid-challenge (e.g. confirm called too early) — tell the client to retry
  // the action. No Payment row recorded.
  if (result.kind === 'requires_action') {
    return c.json(
      {
        status: 'REQUIRES_ACTION',
        clientSecret: result.clientSecret,
        paymentIntentId: result.paymentIntentId,
      },
      200,
    );
  }

  // Succeeded — record the Payment row (idempotent; safe if the webhook or a
  // double-submit got here first). amount_received from Stripe is authoritative.
  const amountCents = result.amountCents;
  const recorded = await recordSettledPayment(c, order, amountCents, result);

  return c.json(
    {
      payment: {
        id: recorded.payment.id,
        status: recorded.payment.status,
        amountCents: recorded.payment.amount_cents,
        cardBrand: recorded.payment.card_brand,
        cardLastFour: recorded.payment.card_last_four,
        processorTransactionId: recorded.payment.processor_transaction_id,
        receiptUrl: result.receiptUrl,
      },
      order: {
        id: order.id,
        amountPaidCents: recorded.amountPaidCents,
        balanceDueCents: recorded.balanceDueCents,
      },
    },
    201,
  );
});

/**
 * POST /api/payments/:id/refund — staff (order:refund). Refunds a Payment fully
 * or partially via Stripe, updates the Payment's refunded_cents + status, rolls
 * the order's amount_paid / balance_due back, and logs an OrderEvent.
 */
payments.post('/:id/refund', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:refund');

  if (!isStripeConfigured()) {
    return c.json({ error: 'payments not configured' }, 501);
  }

  const paymentId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = refundSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }

  const payment = await c.var.db.payment.findUnique({ where: { id: paymentId } });
  if (!payment) {
    return c.json({ error: 'Payment not found' }, 404);
  }
  if (payment.processor !== 'STRIPE' || !payment.processor_transaction_id) {
    return c.json({ error: 'Payment is not a refundable Stripe transaction' }, 400);
  }

  const refundable = payment.amount_cents - payment.refunded_cents;
  if (refundable <= 0) {
    return c.json({ error: 'Payment has already been fully refunded' }, 400);
  }

  const amountCents = parsed.data.amountCents ?? refundable;
  if (amountCents > refundable) {
    return c.json(
      { error: 'Refund exceeds the refundable amount', refundableCents: refundable },
      400,
    );
  }

  // Issue the refund with Stripe OUTSIDE the DB transaction.
  let result;
  try {
    result = await refundPayment({
      paymentId: payment.processor_transaction_id,
      amountCents,
      reason: parsed.data.reason,
    });
  } catch (err) {
    return stripeErrorResponse(c, err);
  }

  const newRefunded = payment.refunded_cents + amountCents;
  const newStatus = newRefunded >= payment.amount_cents ? 'REFUNDED' : 'PARTIAL_REFUND';

  // Roll the order balance back. Load inside the tx for a consistent read.
  const updated = await withTenant(c.var.operatorId, async (tx) => {
    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: { refunded_cents: newRefunded, status: newStatus },
    });

    const order = await tx.order.findUnique({ where: { id: payment.order_id } });
    let orderSummary: { amountPaidCents: number; balanceDueCents: number } | null = null;
    if (order) {
      const newAmountPaid = Math.max(0, order.amount_paid_cents - amountCents);
      const newBalanceDue = order.total_cents - newAmountPaid;
      await tx.order.update({
        where: { id: order.id },
        data: { amount_paid_cents: newAmountPaid, balance_due_cents: newBalanceDue },
      });
      orderSummary = { amountPaidCents: newAmountPaid, balanceDueCents: newBalanceDue };
    }

    await tx.orderEvent.create({
      data: {
        id: createId(),
        operator_id: c.var.operatorId,
        order_id: payment.order_id,
        type: 'REFUND',
        description: `Refunded ${(amountCents / 100).toFixed(2)} USD${
          parsed.data.reason ? ` — ${parsed.data.reason}` : ''
        }`,
        actor: c.var.auth.userId,
        metadata: {
          paymentId: payment.id,
          processorRefundId: result.refundId,
          amountCents,
          reason: parsed.data.reason ?? null,
        },
      },
    });

    return { updatedPayment, orderSummary };
  });

  return c.json({
    refund: {
      id: result.refundId,
      status: result.status,
      amountCents,
    },
    payment: {
      id: updated.updatedPayment.id,
      status: updated.updatedPayment.status,
      amountCents: updated.updatedPayment.amount_cents,
      refundedCents: updated.updatedPayment.refunded_cents,
    },
    order: updated.orderSummary,
  });
});
