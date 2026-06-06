/**
 * Payments API — charge a booking and refund it (Stripe, test-first).
 *
 *   POST /api/payments/charge             public — charge a card against an order
 *   POST /api/payments/confirm            public — finalize a 3DS-challenged charge
 *   POST /api/payments/gift-card          staff  — apply a gift card as tender (order:write)
 *   POST /api/payments/customer/gift-card customer — pay your OWN order with a gift card
 *   POST /api/payments/:id/refund         staff  — full/partial refund (order:refund)
 *
 * All money is integer cents. Every DB write is tenant-scoped (RLS via c.var.db)
 * and the multi-row mutations run inside a single tenant transaction so an order's
 * balance and its payment row can never drift. Stripe's network call happens
 * BEFORE the transaction (you don't want to hold a DB tx open across an external
 * HTTP call); the transaction then records the already-settled result.
 *
 * 3-D Secure / SCA flow:
 *   1. POST /charge → if Stripe requires SCA, returns 200 { requiresAction:true,
 *      clientSecret, paymentIntentId } without recording anything in the DB.
 *   2. Browser calls stripe.handleNextAction({ clientSecret }) to complete the
 *      challenge, then POSTs to /confirm with { paymentIntentId, orderId }.
 *   3. POST /confirm retrieves the intent; if succeeded, runs the SAME persistence
 *      block as the synchronous /charge success path.
 *
 * Idempotency-Key:
 *   The client may supply an `Idempotency-Key` request header on /charge. If
 *   present it is passed through to Stripe so a double-submit returns the same
 *   charge. If absent, a fresh createId() is used (as before).
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
  finalizePayment,
  refundPayment,
  isStripeConfigured,
  StripeNotConfiguredError,
  StripePaymentError,
  type StripePaymentResult,
} from '../services/stripe.js';
import { applyGiftCardToOrder, refundGiftCardPayment, GiftCardError } from '../services/giftcards.js';
import { isEmailConfigured, sendRefundReceipt } from '../services/notifications.js';
import { customerIdentityFromHeader } from '../services/customer-auth.js';

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

  // Prefer a client-supplied Idempotency-Key header (double-submit safety), fall back
  // to the body field, then generate a fresh one. Hono lowercases header names, so
  // 'Idempotency-Key' and 'idempotency-key' both match.
  const idempotencyKey =
    c.req.header('idempotency-key') ?? parsed.data.idempotencyKey ?? createId();

  // Charge Stripe OUTSIDE the DB transaction (external network call).
  let outcome;
  try {
    outcome = await createPayment({
      orderId: order.id,
      sourceId,
      amountCents,
      idempotencyKey,
    });
  } catch (err) {
    return stripeErrorResponse(c, err);
  }

  // 3-D Secure / SCA: tell the browser to complete the challenge, then call /confirm.
  // No DB writes yet — we only persist once the charge has actually settled.
  if (outcome.status === 'requires_action') {
    return c.json(
      {
        requiresAction: true,
        clientSecret: outcome.clientSecret,
        paymentIntentId: outcome.paymentIntentId,
      },
      200,
    );
  }

  // Synchronous success — record the settled charge atomically against the order.
  const result = outcome; // narrowed: StripePaymentResult
  const { payment, newAmountPaid, newBalanceDue } = await persistSettledCharge({
    operatorId: c.var.operatorId,
    order,
    amountCents,
    result,
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

// ---------------------------------------------------------------------------
// Shared helper — persist a settled Stripe charge (used by /charge success +
// /confirm, so the two paths are guaranteed to write identically).
// ---------------------------------------------------------------------------

type OrderRow = { id: string; total_cents: number; amount_paid_cents: number };

async function persistSettledCharge(opts: {
  operatorId: string;
  order: OrderRow;
  amountCents: number;
  result: StripePaymentResult;
}): Promise<{ payment: { id: string; status: string; amount_cents: number; card_brand: string | null; card_last_four: string | null; processor_transaction_id: string | null }; newAmountPaid: number; newBalanceDue: number }> {
  const { operatorId, order, amountCents, result } = opts;
  const newAmountPaid = order.amount_paid_cents + amountCents;
  const newBalanceDue = order.total_cents - newAmountPaid;

  const payment = await withTenant(operatorId, async (tx) => {
    const created = await tx.payment.create({
      data: {
        id: createId(),
        operator_id: operatorId,
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
        operator_id: operatorId,
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

  return { payment, newAmountPaid, newBalanceDue };
}

// ---------------------------------------------------------------------------
// POST /api/payments/confirm — finalize a 3DS-challenged charge.
//
// Called by the browser after stripe.handleNextAction() resolves successfully.
// Body: { paymentIntentId: string; orderId: string }
// Retrieves the PaymentIntent from Stripe; if it is `succeeded`, runs the same
// persistence as the synchronous /charge success path. Returns the same 201
// payment + order shape as /charge. Refuses with 402 if not yet succeeded.
// ---------------------------------------------------------------------------

const confirmSchema = z.object({
  paymentIntentId: z.string().min(1),
  orderId: z.string().min(1),
});

payments.post('/confirm', async (c) => {
  if (!isStripeConfigured()) {
    return c.json({ error: 'payments not configured' }, 501);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  const { paymentIntentId, orderId } = parsed.data;

  // Load the order to verify it exists, get the balance, and avoid persisting
  // more than the outstanding amount.
  const order = await c.var.db.order.findUnique({ where: { id: orderId } });
  if (!order) {
    return c.json({ error: 'Order not found' }, 404);
  }

  // Guard against duplicate confirms (e.g. double-tap): if the order is already
  // fully paid there is nothing left to record.
  if (order.balance_due_cents <= 0) {
    return c.json({ error: 'This order has already been paid in full' }, 409);
  }

  // Retrieve + verify the intent is genuinely succeeded (throws 402 if not).
  let result;
  try {
    result = await finalizePayment(paymentIntentId);
  } catch (err) {
    return stripeErrorResponse(c, err);
  }

  // Use the settled amount from Stripe; cap at balance_due to be safe.
  const amountCents = Math.min(result.amountCents, order.balance_due_cents);

  const { payment, newAmountPaid, newBalanceDue } = await persistSettledCharge({
    operatorId: c.var.operatorId,
    order,
    amountCents,
    result,
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

// ---------------------------------------------------------------------------

const giftCardTenderSchema = z.object({
  orderId: z.string().min(1),
  /** The gift card's redemption code (the bearer secret). */
  code: z.string().min(1),
  /** Amount to apply, integer cents. Omit to apply as much as covers the balance. */
  amountCents: z.number().int().positive().optional(),
});

/**
 * POST /api/payments/gift-card — staff (order:write). Applies a gift card as tender
 * against an order's outstanding balance. Stored value, so this needs no Stripe
 * config; the whole draw-down + Payment + order update is one atomic tenant tx in
 * services/giftcards.ts (overspend-safe). Customer-checkout gift-card tender is a
 * follow-up (ties into customer auth); this is the staff/POS path.
 */
payments.post('/gift-card', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:write');

  const parsed = giftCardTenderSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }

  try {
    const result = await applyGiftCardToOrder(
      c.var.operatorId,
      parsed.data.orderId,
      parsed.data.code,
      { amountCents: parsed.data.amountCents, actor: c.var.auth.userId },
    );
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof GiftCardError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

/**
 * POST /api/payments/customer/gift-card — customer self-service gift-card tender.
 * Requires a customer session token (Authorization: Bearer from
 * /api/auth/customer/verify); a customer may only pay down THEIR OWN order. Reuses
 * the same atomic, overspend-safe service as the staff endpoint.
 */
payments.post('/customer/gift-card', async (c) => {
  const identity = await customerIdentityFromHeader(c.req.header('authorization'), c.var.operatorId);
  if (!identity) {
    return c.json({ error: 'Sign in to pay with a gift card' }, 401);
  }

  const parsed = giftCardTenderSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }

  // The order must belong to the authenticated customer (match by email). Same 404
  // whether it's missing or someone else's — don't leak which orders exist.
  const order = await c.var.db.order.findFirst({
    where: { id: parsed.data.orderId },
    select: { customer: { select: { email: true } } },
  });
  if (!order || order.customer.email.toLowerCase() !== identity.email) {
    return c.json({ error: 'We could not find a matching order' }, 404);
  }

  try {
    const result = await applyGiftCardToOrder(c.var.operatorId, parsed.data.orderId, parsed.data.code, {
      amountCents: parsed.data.amountCents,
      actor: `customer:${identity.email}`,
    });
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof GiftCardError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

/**
 * POST /api/payments/:id/refund — staff (order:refund). Refunds a Payment fully or
 * partially, updates its refunded_cents + status, rolls the order's amount_paid /
 * balance_due back, and logs an OrderEvent. Polymorphic by tender: a GIFT_CARD
 * payment credits the originating gift card back (stored value, no Stripe — see
 * services/giftcards.refundGiftCardPayment); a card payment settles through Stripe.
 */
payments.post('/:id/refund', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:refund');

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

  // Gift-card tender refunds back to the originating card (stored value — no Stripe).
  if (payment.method === 'GIFT_CARD') {
    try {
      const result = await refundGiftCardPayment(c.var.operatorId, paymentId, {
        amountCents: parsed.data.amountCents,
        reason: parsed.data.reason,
        actor: c.var.auth.userId,
      });
      if (isEmailConfigured()) {
        void sendRefundReceipt({
          operatorId: c.var.operatorId,
          paymentId,
          refundedCents: result.refund.amountCents,
          reason: parsed.data.reason,
        });
      }
      return c.json(result);
    } catch (err) {
      if (err instanceof GiftCardError) {
        return c.json({ error: err.message, code: err.code }, err.status as 400);
      }
      throw err;
    }
  }

  // Card payments settle through Stripe.
  if (!isStripeConfigured()) {
    return c.json({ error: 'payments not configured' }, 501);
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

  if (isEmailConfigured()) {
    void sendRefundReceipt({
      operatorId: c.var.operatorId,
      paymentId: payment.id,
      refundedCents: amountCents,
      reason: parsed.data.reason,
    });
  }

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
