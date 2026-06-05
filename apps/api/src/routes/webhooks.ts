/**
 * Stripe webhooks — POST /webhooks/stripe
 *
 * Stripe calls this endpoint server-to-server when payments and refunds change
 * state (a refund clears, a payment fails, a dispute adjusts the balance). We use
 * these events to keep our local `Payment` row in sync with Stripe's source of
 * truth so reconciliation and the admin UI never drift from reality.
 *
 * TENANCY: Stripe has no concept of our operators, so the request arrives with NO
 * tenant context — it is mounted OUTSIDE the /api tenant middleware. We resolve the
 * operator from the linkage we already store: every Payment keeps the Stripe
 * PaymentIntent id in `processor_transaction_id`, so we look the row up (admin
 * client, by that id — the one intentionally cross-tenant lookup) to discover its
 * `operator_id`, then write through the tenant-scoped client `forOperator(...)` so
 * the RLS policies still apply on the mutation.
 *
 * SECURITY: if `STRIPE_WEBHOOK_SECRET` is set the signature is verified on every
 * request (constructWebhookEvent throws on mismatch -> 401). If it is unset
 * (local/dev) we accept unverified events so the flow can be exercised against the
 * Stripe CLI without a registered endpoint.
 *
 * ROBUSTNESS: unknown event types, already-deleted payments, and payments we don't
 * recognize all return 200 — Stripe retries non-2xx responses with backoff, and we
 * never want to be retried for an event we have intentionally ignored. All money is
 * integer cents (Stripe's native unit).
 */
import { Hono } from 'hono';
import type Stripe from 'stripe';
import { adminPrisma, forOperator, type PaymentStatus } from '@marina/database';
import type { Env } from '../context.js';
import { constructWebhookEvent, StripePaymentError } from '../services/stripe.js';

export const webhooks = new Hono<Env>();

/** Derive our PaymentStatus purely from the cumulative refunded total. */
function statusFromRefundTotals(amountCents: number, refundedCents: number): PaymentStatus {
  if (refundedCents <= 0) return 'PAID';
  return refundedCents >= amountCents ? 'REFUNDED' : 'PARTIAL_REFUND';
}

/** Find our Payment row for a Stripe PaymentIntent id (cross-tenant admin lookup). */
async function findPaymentByIntent(intentId: string | null | undefined) {
  if (!intentId) return null;
  return adminPrisma.payment.findFirst({
    where: { processor_transaction_id: intentId, processor: 'STRIPE' },
    select: { id: true, operator_id: true, amount_cents: true, refunded_cents: true },
  });
}

/**
 * `charge.refunded` — Stripe sends the full Charge with its cumulative
 * `amount_refunded`. Sync that onto the Payment (monotonic + idempotent under
 * retries) and recompute status.
 */
async function handleChargeRefunded(charge: Stripe.Charge): Promise<boolean> {
  const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  const existing = await findPaymentByIntent(intentId);
  if (!existing) return false;

  const refundedCents = Math.min(
    existing.amount_cents,
    Math.max(existing.refunded_cents, charge.amount_refunded ?? 0),
  );
  const status = statusFromRefundTotals(existing.amount_cents, refundedCents);

  const db = forOperator(existing.operator_id);
  await db.payment.update({
    where: { id: existing.id },
    data: { status, refunded_cents: refundedCents },
  });
  return true;
}

/** `payment_intent.*` — sync the headline PAID/FAILED status. */
async function handleIntentStatus(intent: Stripe.PaymentIntent, status: PaymentStatus): Promise<boolean> {
  const existing = await findPaymentByIntent(intent.id);
  if (!existing) return false;
  const db = forOperator(existing.operator_id);
  await db.payment.update({ where: { id: existing.id }, data: { status } });
  return true;
}

/**
 * POST /webhooks/stripe — receive and process Stripe event notifications.
 *
 * Always 200 for events we successfully receive (verified or intentionally
 * ignored) so Stripe does not retry. 401 only for a failed signature check; 400
 * for a body that isn't JSON.
 */
webhooks.post('/stripe', async (c) => {
  // The signature is computed over the EXACT raw bytes — read text(), never the
  // re-serialized JSON (key order/whitespace would differ and break verification).
  const rawBody = await c.req.text();
  const signature = c.req.header('stripe-signature');

  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(rawBody, signature);
  } catch (err) {
    if (err instanceof StripePaymentError) {
      return c.json({ error: err.message }, err.status === 401 ? 401 : 400);
    }
    return c.json({ error: 'Invalid webhook body' }, 400);
  }

  try {
    switch (event.type) {
      case 'charge.refunded':
        await handleChargeRefunded(event.data.object as Stripe.Charge);
        break;
      case 'payment_intent.succeeded':
        await handleIntentStatus(event.data.object as Stripe.PaymentIntent, 'PAID');
        break;
      case 'payment_intent.payment_failed':
        await handleIntentStatus(event.data.object as Stripe.PaymentIntent, 'FAILED');
        break;
      default:
        // Unknown/unhandled event type — acknowledge so Stripe stops retrying.
        break;
    }
  } catch (err) {
    // A processing failure (e.g. transient DB error) SHOULD be retried by Stripe,
    // so surface a 500 here rather than swallowing it.
    console.error('stripe webhook processing failed', {
      type: event.type,
      eventId: event.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: 'Webhook processing failed' }, 500);
  }

  return c.json({ ok: true });
});
