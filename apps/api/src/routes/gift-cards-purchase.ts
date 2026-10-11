/**
 * Public gift-card purchase.
 *
 *   POST /api/public/gift-cards/purchase   PUBLIC — buy a gift card online
 *
 * The flow: the buyer names a denomination + a tokenized card + the recipient. The
 * server is the PRICE AUTHORITY — it re-derives the amount from the allowed
 * denomination set (services/gift-cards.resolvePurchaseAmountCents), so the amount
 * charged and the value loaded onto the card are the SAME number re-computed here,
 * never a client-sent price. We then:
 *
 *   1. charge the card through the PaymentProvider seam (services/payments),
 *   2. only on a settled success, issueGiftCard() for exactly that amount, and
 *   3. email the code to the recipient.
 *
 * Card issuance happens AFTER the charge settles so a declined/challenged card
 * never mints a live card. A 3DS challenge is reported as a plain decline here
 * (402): the gift page collects a test/non-3DS card in the sandbox, and wiring a
 * full challenge round-trip for a standalone purchase is out of scope — the money
 * is never taken without a card ever being issued, which is the invariant that
 * matters.
 *
 * Tenant-scoped by RLS via the /api tenant middleware.
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { createId } from '@marina/core';
import type { Env } from '../context.js';
import { rateLimit } from '../middleware/rate-limit.js';
import {
  getPaymentProvider,
  PaymentProviderError,
} from '../services/payments/index.js';
import {
  issueGiftCard,
  resolvePurchaseAmountCents,
  GiftCardError,
} from '../services/gift-cards.js';
import { sendGiftCardIssued } from '../services/notifications.js';

export const giftCardsPurchase = new Hono<Env>();

// Buying a gift card moves money and emails a bearer code; throttle per IP + tenant
// the same way the other public money/code endpoints are.
const publicRateLimit = rateLimit();

const purchaseSchema = z.object({
  /**
   * The denomination the buyer picked, integer cents. The server treats this as a
   * REQUEST only and re-derives the authoritative amount from the allowed set, so a
   * tampered value is rejected rather than charged.
   */
  amountCents: z.number().int().positive(),
  /** Tokenized payment source (Stripe PaymentMethod id / sandbox token). */
  sourceId: z.string().min(1, 'A payment method is required'),
  recipientEmail: z.string().email('Enter a valid recipient email'),
  recipientName: z.string().trim().max(160).optional(),
  purchaserEmail: z.string().email().optional(),
  purchaserName: z.string().trim().max(160).optional(),
  message: z.string().trim().max(500).optional(),
  /** Stable retry key so a double-submit does not charge (or issue) twice. */
  idempotencyKey: z.string().min(1).max(45).optional(),
});

/**
 * POST /api/public/gift-cards/purchase — buy a gift card online.
 */
giftCardsPurchase.post('/purchase', publicRateLimit, async (c) => {
  const provider = await getPaymentProvider(c.var.operatorId);
  if (provider.providerKey === 'none') {
    return c.json({ error: 'payments not configured' }, 501);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = purchaseSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }

  // PRICE AUTHORITY: re-derive the amount server-side. This single value is what we
  // charge AND what we load onto the card — a mismatch is impossible by construction.
  let amountCents: number;
  try {
    amountCents = resolvePurchaseAmountCents(parsed.data.amountCents);
  } catch (err) {
    if (err instanceof GiftCardError) {
      return c.json({ error: err.message, code: err.code }, err.status as ContentfulStatusCode);
    }
    throw err;
  }

  const idempotencyKey = parsed.data.idempotencyKey ?? createId();

  // A synthetic order ref for the processor's metadata/ledger. A gift-card purchase
  // has no Order row; the sandbox attempt's order_id is a soft link (no FK), so this
  // is safe and keeps the charge traceable back to the purchase.
  const purchaseRef = `giftcard-purchase-${idempotencyKey}`;

  // Charge OUTSIDE any DB transaction (external network call), exactly as the
  // booking charge path does.
  let outcome;
  try {
    outcome = await provider.charge({
      orderId: purchaseRef,
      tokenizedSource: parsed.data.sourceId,
      amountCents,
      idempotencyKey,
      operatorId: c.var.operatorId,
    });
  } catch (err) {
    if (err instanceof PaymentProviderError) {
      return c.json({ error: err.message, code: err.code ?? null }, err.status as ContentfulStatusCode);
    }
    throw err;
  }

  // A 3DS challenge is not a settled charge — no money has been taken, so no card is
  // issued. Report it as a decline the gift page can retry with a simpler card.
  if (outcome.status === 'requires_action') {
    return c.json(
      {
        error: 'This card needs extra authentication. Please try a different card.',
        code: 'requires_action',
      },
      402,
    );
  }
  if (outcome.status === 'failed') {
    return c.json(
      { error: outcome.failure.message, code: outcome.failure.code },
      outcome.failure.httpStatus as ContentfulStatusCode,
    );
  }

  // The processor is the authority on what actually settled. Issue the card for the
  // amount that MOVED, not the requested amount, so the card value can never exceed
  // the money taken even on a partial capture.
  const settledCents = outcome.amountCents;

  // Only now — after a confirmed, settled charge — mint the card.
  let card;
  try {
    card = await issueGiftCard(c.var.operatorId, {
      initialCents: settledCents,
      purchaserEmail: parsed.data.purchaserEmail,
      recipientName: parsed.data.recipientName,
      recipientEmail: parsed.data.recipientEmail,
      message: parsed.data.message,
    });
  } catch (err) {
    if (err instanceof GiftCardError) {
      return c.json({ error: err.message, code: err.code }, err.status as ContentfulStatusCode);
    }
    throw err;
  }

  // Email the code to the recipient. Never blocks or fails the purchase — the buyer
  // already paid and the card exists; a dead email path is logged, not fatal.
  const emailResult = await sendGiftCardIssued({
    operatorId: c.var.operatorId,
    code: card.code,
    amountCents: card.balance_cents,
    recipientEmail: parsed.data.recipientEmail,
    recipientName: parsed.data.recipientName ?? null,
    purchaserName: parsed.data.purchaserName ?? null,
    giftMessage: parsed.data.message ?? null,
  });

  return c.json(
    {
      giftCard: {
        id: card.id,
        code: card.code,
        balanceCents: card.balance_cents,
        status: card.status,
        recipientEmail: card.recipient_email,
      },
      // quote == charge == balance, all the same server-derived number.
      amountChargedCents: settledCents,
      payment: {
        processorTransactionId: outcome.paymentRef,
        cardBrand: outcome.cardBrand,
        cardLastFour: outcome.cardLastFour,
        receiptUrl: outcome.receiptUrl,
      },
      emailSent: emailResult.sent === true,
    },
    201,
  );
});
