/**
 * Payment webhooks — POST /webhooks/stripe
 *
 * The payment processor calls this endpoint server-to-server when payments and
 * refunds change state (a refund clears, a payment fails, a dispute adjusts the
 * balance). We use these events to keep our local `Payment` row in sync with the
 * processor's source of truth so reconciliation and the admin UI never drift from
 * reality.
 *
 * PROVIDER SEAM: verification + parsing is owned by the resolved PaymentProvider
 * (`getWebhookProvider().verifyAndParseWebhook`), which normalizes processor
 * events to three facts — payment_succeeded, payment_failed, refund_completed —
 * and this route only knows how to apply those to the ledger. The path stays
 * `/webhooks/stripe` for back-compat (it is what live Stripe endpoints and the
 * local simulator are pointed at); a second processor would mount its own path
 * here and resolve its own provider.
 *
 * TENANCY: processors have no concept of our operators, so the request arrives
 * with NO tenant context — it is mounted OUTSIDE the /api tenant middleware. We
 * resolve the operator from the linkage we already store: every Payment keeps the
 * processor's charge handle in `processor_transaction_id`, so we look the row up
 * (admin client, by that id — the one intentionally cross-tenant lookup) to
 * discover its `operator_id`, then write through the tenant-scoped client
 * `forOperator(...)` so the RLS policies still apply on the mutation.
 *
 * SECURITY: the Stripe provider verifies the signature on every request when
 * `STRIPE_WEBHOOK_SECRET` is set (throws → 401). When it is unset (local/dev) the
 * body is parsed unverified so the flow can be exercised against the Stripe CLI —
 * or the local simulator — without a registered endpoint.
 *
 * ROBUSTNESS: unknown event types, already-deleted payments, and payments we don't
 * recognize all return 200 — processors retry non-2xx responses with backoff, and
 * we never want to be retried for an event we have intentionally ignored. All
 * money is integer cents.
 */
import { Hono } from 'hono';
import { adminPrisma, forOperator, type PaymentStatus } from '@marina/database';
import type { Env } from '../context.js';
import {
  getWebhookProvider,
  PaymentProviderError,
  type NormalizedPaymentEvent,
} from '../services/payments/index.js';

export const webhooks = new Hono<Env>();

/** Derive our PaymentStatus purely from the cumulative refunded total. */
function statusFromRefundTotals(amountCents: number, refundedCents: number): PaymentStatus {
  if (refundedCents <= 0) return 'PAID';
  return refundedCents >= amountCents ? 'REFUNDED' : 'PARTIAL_REFUND';
}

/**
 * Find our Payment row for a processor charge handle (cross-tenant admin lookup).
 * Matched on `processor_transaction_id` alone — that handle is the processor's own
 * unique charge id, so it identifies the row regardless of which processor
 * (Stripe/Square) issued it. We intentionally do NOT narrow by `processor` here:
 * the resolved webhook provider already proved the event's authenticity, and
 * pinning a single processor would silently drop every Square (or future-processor)
 * event whose row isn't STRIPE.
 */
async function findPaymentByRef(paymentRef: string | null | undefined) {
  if (!paymentRef) return null;
  return adminPrisma.payment.findFirst({
    where: { processor_transaction_id: paymentRef },
    select: { id: true, operator_id: true, amount_cents: true, refunded_cents: true },
  });
}

/**
 * Apply one normalized event to the ledger. Returns false when the payment is not
 * ours to update (unknown ref) — acknowledged, never retried.
 */
async function applyPaymentEvent(event: NormalizedPaymentEvent): Promise<boolean> {
  const existing = await findPaymentByRef(event.paymentRef);
  if (!existing) return false;
  const db = forOperator(existing.operator_id);

  switch (event.type) {
    case 'payment_succeeded':
      await db.payment.update({ where: { id: existing.id }, data: { status: 'PAID' } });
      return true;
    case 'payment_failed':
      await db.payment.update({ where: { id: existing.id }, data: { status: 'FAILED' } });
      return true;
    case 'refund_completed': {
      // The event carries the CUMULATIVE refunded total. Sync it onto the Payment
      // (monotonic + idempotent under retries) and recompute status.
      const refundedCents = Math.min(
        existing.amount_cents,
        Math.max(existing.refunded_cents, event.refundedTotalCents),
      );
      await db.payment.update({
        where: { id: existing.id },
        data: {
          status: statusFromRefundTotals(existing.amount_cents, refundedCents),
          refunded_cents: refundedCents,
        },
      });
      return true;
    }
  }
}

/**
 * POST /webhooks/stripe — receive and process payment event notifications.
 *
 * Always 200 for events we successfully receive (verified or intentionally
 * ignored) so the processor does not retry. 401 only for a failed signature check;
 * 400 for a body that isn't parseable or when no provider is configured.
 */
webhooks.post('/stripe', async (c) => {
  // The signature is computed over the EXACT raw bytes — read text(), never the
  // re-serialized JSON (key order/whitespace would differ and break verification).
  const rawBody = await c.req.text();
  const provider = await getWebhookProvider();

  let parsed;
  try {
    parsed = provider.verifyAndParseWebhook(rawBody, (name) => c.req.header(name));
  } catch (err) {
    if (err instanceof PaymentProviderError) {
      return c.json({ error: err.message }, err.status === 401 ? 401 : 400);
    }
    return c.json({ error: 'Invalid webhook body' }, 400);
  }

  try {
    for (const event of parsed.events) {
      await applyPaymentEvent(event);
    }
  } catch (err) {
    // A processing failure (e.g. transient DB error) SHOULD be retried by the
    // processor, so surface a 500 here rather than swallowing it.
    console.error('payment webhook processing failed', {
      type: parsed.providerEventType,
      eventId: parsed.providerEventId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: 'Webhook processing failed' }, 500);
  }

  return c.json({ ok: true });
});
