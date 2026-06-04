/**
 * Square webhooks — POST /webhooks/square
 *
 * Square calls this endpoint server-to-server when payments and refunds change
 * state (e.g. a refund clears asynchronously, a payment is voided, a dispute
 * adjusts the balance). We use these events to keep our local `Payment` row in
 * sync with Square's source of truth so reconciliation and the admin UI never
 * drift from reality.
 *
 * TENANCY: Square has no concept of our operators, so the request arrives with
 * NO tenant context — it is mounted OUTSIDE the /api tenant middleware. We resolve
 * the operator from the linkage Square already gives us: every Payment we create
 * stores the Square payment id in `processor_transaction_id`, so we look the row up
 * (admin client, by that id, the one intentionally cross-tenant lookup) to discover
 * its `operator_id`, then perform the actual write through the tenant-scoped client
 * `forOperator(operatorId)` so the RLS policies still apply on the mutation.
 *
 * SECURITY: if `SQUARE_WEBHOOK_SIGNATURE_KEY` is set we verify the HMAC signature
 * on every request and reject (401) anything that doesn't validate. If it is unset
 * (local/dev where no webhook subscription exists) we accept unverified events so
 * the flow can be exercised end-to-end against the Square sandbox CLI.
 *
 * ROBUSTNESS: unknown event types, already-deleted payments, and payments we don't
 * recognize all return 200 — Square retries non-2xx responses with backoff, and we
 * never want to be retried for an event we have intentionally ignored. All money is
 * integer cents.
 */
import { Hono } from 'hono';
import { WebhooksHelper } from 'square';
import { adminPrisma, forOperator, type PaymentStatus } from '@marina/database';
import type { Env } from '../context.js';

export const webhooks = new Hono<Env>();

/** Square's signature header (lower-cased; Hono normalizes header names). */
const SIGNATURE_HEADER = 'x-square-hmacsha256-signature';

// --- Webhook payload shapes ------------------------------------------------
// Square's webhook JSON is snake_case (the SDK only camelCases when it
// deserializes through its own client). We parse the raw body ourselves, so we
// model exactly the snake_case fields we read. Everything is optional/defensive
// because Square may add fields and we must never throw on an unexpected shape.

interface SquareMoney {
  amount?: number | null;
  currency?: string | null;
}

interface SquarePaymentObject {
  id?: string;
  status?: string | null;
  amount_money?: SquareMoney | null;
  refunded_money?: SquareMoney | null;
  card_details?: {
    card?: { last_4?: string | null; card_brand?: string | null } | null;
    cardholder_name?: string | null;
  } | null;
}

interface SquareRefundObject {
  id?: string;
  status?: string | null;
  payment_id?: string | null;
  amount_money?: SquareMoney | null;
}

interface SquareWebhookEvent {
  type?: string;
  event_id?: string;
  data?: {
    type?: string;
    id?: string;
    object?: {
      payment?: SquarePaymentObject;
      refund?: SquareRefundObject;
    } | null;
  } | null;
}

// --- Status mapping --------------------------------------------------------

/**
 * Map a Square payment status + refunded amount onto our PaymentStatus enum.
 * Square payment statuses: APPROVED, PENDING, COMPLETED, CANCELED, FAILED.
 * A COMPLETED payment may also carry a non-zero refunded amount.
 */
function mapPaymentStatus(
  squareStatus: string | null | undefined,
  amountCents: number,
  refundedCents: number,
): PaymentStatus {
  switch ((squareStatus ?? '').toUpperCase()) {
    case 'FAILED':
    case 'CANCELED':
      return 'FAILED';
    case 'APPROVED':
    case 'PENDING':
      return 'PRE_AUTHORIZED';
    case 'COMPLETED':
    default:
      if (refundedCents <= 0) return 'PAID';
      return refundedCents >= amountCents ? 'REFUNDED' : 'PARTIAL_REFUND';
  }
}

/** Derive our PaymentStatus purely from the cumulative refunded total. */
function statusFromRefundTotals(amountCents: number, refundedCents: number): PaymentStatus {
  if (refundedCents <= 0) return 'PAID';
  return refundedCents >= amountCents ? 'REFUNDED' : 'PARTIAL_REFUND';
}

function moneyCents(m: SquareMoney | null | undefined): number {
  const amount = m?.amount;
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
}

// --- Signature verification ------------------------------------------------

/**
 * The notification URL Square HMACs together with the body. Prefer the explicit
 * env value (correct behind proxies/load balancers that rewrite host/scheme);
 * otherwise reconstruct it from the request. Must byte-match the URL configured
 * on the Square webhook subscription.
 */
function notificationUrl(reqUrl: string): string {
  return process.env.SQUARE_WEBHOOK_NOTIFICATION_URL ?? reqUrl;
}

/**
 * Verify the Square signature. Returns true when verification passes OR when no
 * signature key is configured (dev). Returns false only when a key IS configured
 * and the signature is missing/invalid.
 */
async function verifySignature(
  rawBody: string,
  signature: string | undefined,
  reqUrl: string,
): Promise<boolean> {
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!key) return true; // dev: no subscription configured, accept unverified
  if (!signature) return false;
  try {
    return await WebhooksHelper.verifySignature({
      requestBody: rawBody,
      signatureHeader: signature,
      signatureKey: key,
      notificationUrl: notificationUrl(reqUrl),
    });
  } catch {
    return false;
  }
}

// --- Event handlers --------------------------------------------------------

/**
 * Sync a `payment.updated` event onto the local Payment row. Looks the row up by
 * Square payment id (cross-tenant admin lookup is the only allowed unscoped read
 * here), then writes through the tenant-scoped client so RLS still governs the
 * mutation. Returns whether a row was updated (purely for logging/visibility).
 */
async function handlePaymentUpdated(payment: SquarePaymentObject | undefined): Promise<boolean> {
  const squarePaymentId = payment?.id;
  if (!squarePaymentId) return false;

  const existing = await adminPrisma.payment.findFirst({
    where: { processor_transaction_id: squarePaymentId, processor: 'SQUARE' },
    select: { id: true, operator_id: true, amount_cents: true, refunded_cents: true },
  });
  if (!existing) return false; // unknown payment — not ours; ignore (200)

  const refundedCents = moneyCents(payment?.refunded_money);
  const amountCents = moneyCents(payment?.amount_money) || existing.amount_cents;
  const status = mapPaymentStatus(payment?.status, amountCents, refundedCents);
  const card = payment?.card_details?.card;

  const db = forOperator(existing.operator_id);
  await db.payment.update({
    where: { id: existing.id },
    data: {
      status,
      refunded_cents: refundedCents,
      // Backfill card metadata if Square now provides it and we lack it.
      ...(card?.last_4 ? { card_last_four: card.last_4 } : {}),
      ...(card?.card_brand ? { card_brand: card.card_brand } : {}),
      ...(payment?.card_details?.cardholder_name
        ? { cardholder_name: payment.card_details.cardholder_name }
        : {}),
    },
  });
  return true;
}

/**
 * Sync a `refund.updated` event onto the local Payment row. We key off the
 * refund's `payment_id` (the Square payment id) to find our Payment, then set the
 * cumulative refunded amount and recompute status. Only COMPLETED refunds move
 * money; other refund states are acknowledged without changing totals.
 */
async function handleRefundUpdated(refund: SquareRefundObject | undefined): Promise<boolean> {
  const squarePaymentId = refund?.payment_id;
  if (!squarePaymentId) return false;

  const existing = await adminPrisma.payment.findFirst({
    where: { processor_transaction_id: squarePaymentId, processor: 'SQUARE' },
    select: { id: true, operator_id: true, amount_cents: true, refunded_cents: true },
  });
  if (!existing) return false;

  const refundStatus = (refund?.status ?? '').toUpperCase();
  const refundAmountCents = moneyCents(refund?.amount_money);

  // Pull the authoritative cumulative refunded total from Square: it is the sum
  // of all COMPLETED refunds. The single event only carries this one refund, so
  // for a COMPLETED refund we take max(existing, thisRefund) to stay monotonic
  // and idempotent under retries; non-completed refunds leave totals unchanged.
  let refundedCents = existing.refunded_cents;
  if (refundStatus === 'COMPLETED') {
    refundedCents = Math.min(
      existing.amount_cents,
      Math.max(existing.refunded_cents, refundAmountCents),
    );
  }

  const status = statusFromRefundTotals(existing.amount_cents, refundedCents);

  const db = forOperator(existing.operator_id);
  await db.payment.update({
    where: { id: existing.id },
    data: { status, refunded_cents: refundedCents },
  });
  return true;
}

// --- Route -----------------------------------------------------------------

/**
 * POST /webhooks/square — receive and process Square event notifications.
 *
 * Always 200 for events we successfully receive (verified or intentionally
 * ignored) so Square does not retry. 401 only for a failed signature check; 400
 * for a body that isn't JSON.
 */
webhooks.post('/square', async (c) => {
  // The signature is computed over the EXACT raw bytes — read text(), never the
  // re-serialized JSON (key order/whitespace would differ and break the HMAC).
  const rawBody = await c.req.text();
  const signature = c.req.header(SIGNATURE_HEADER);

  if (!(await verifySignature(rawBody, signature, c.req.url))) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  let event: SquareWebhookEvent;
  try {
    event = JSON.parse(rawBody) as SquareWebhookEvent;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    switch (event.type) {
      case 'payment.updated':
        await handlePaymentUpdated(event.data?.object?.payment);
        break;
      case 'refund.updated':
        await handleRefundUpdated(event.data?.object?.refund);
        break;
      default:
        // Unknown/unhandled event type — acknowledge so Square stops retrying.
        break;
    }
  } catch (err) {
    // A processing failure (e.g. transient DB error) SHOULD be retried by Square,
    // so surface a 500 here rather than swallowing it.
    console.error('square webhook processing failed', {
      type: event.type,
      eventId: event.event_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: 'Webhook processing failed' }, 500);
  }

  return c.json({ ok: true });
});
