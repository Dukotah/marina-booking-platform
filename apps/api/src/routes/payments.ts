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
  refundPayment,
  arePaymentsEnabled,
  StripeNotConfiguredError,
  StripePaymentError,
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

const refundSchema = z.object({
  /** Amount to refund, integer cents. Defaults to the full remaining refundable. */
  amountCents: z.number().int().positive().optional(),
  reason: z.string().max(192).optional(),
});

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
 * POST /api/payments/charge — public. Charges a card via Square, records a
 * Payment row, advances the order's amount_paid / balance_due, and logs an
 * OrderEvent. Public because customers pay during checkout (no staff session).
 */
payments.post('/charge', async (c) => {
  if (!arePaymentsEnabled()) {
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

  // Charge Square OUTSIDE the DB transaction (external network call).
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

  // Record the settled charge atomically against the order.
  const newAmountPaid = order.amount_paid_cents + amountCents;
  const newBalanceDue = order.total_cents - newAmountPaid;

  const payment = await withTenant(c.var.operatorId, async (tx) => {
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

    return created;
  });

  return c.json(
    {
      payment: {
        id: payment.id,
        status: payment.status,
        amountCents: payment.amount_cents,
        cardBrand: payment.card_brand,
        cardLastFour: payment.card_last_four,
        processorTransactionId: payment.processor_transaction_id,
        receiptUrl: result.receiptUrl,
      },
      order: {
        id: order.id,
        amountPaidCents: newAmountPaid,
        balanceDueCents: newBalanceDue,
      },
    },
    201,
  );
});

/**
 * POST /api/payments/:id/refund — staff (order:refund). Refunds a Payment fully
 * or partially via Square, updates the Payment's refunded_cents + status, rolls
 * the order's amount_paid / balance_due back, and logs an OrderEvent.
 */
payments.post('/:id/refund', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:refund');

  if (!arePaymentsEnabled()) {
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

  // Issue the refund with Square OUTSIDE the DB transaction.
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
