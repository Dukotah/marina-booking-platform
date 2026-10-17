/**
 * Square implementation of the PaymentProvider seam (Square Payments API).
 *
 * STATUS: SEAM, NOT WIRED. This file conforms to the `PaymentProvider` interface
 * and does every piece of work that does NOT need the Square SDK or live
 * credentials — amount validation, idempotency-key derivation, client-config
 * shaping, webhook payload parsing + event normalization, and the money-unit
 * conversion. The remaining pieces are the actual network calls to Square, each
 * marked with a `// TODO(square-golive): ...` comment naming the concrete Square
 * API call to make. Those spots THROW a clear "Square live integration not
 * configured" error — they never return a fake success, so an unfinished Square
 * install can never masquerade as a real charge. See docs/SQUARE-GOLIVE.md.
 *
 * Square is selected ONLY when `PAYMENT_PROVIDER=square` is set with Square env
 * keys present (see ./index.ts). Stripe stays the default; the local sandbox still
 * supersedes everything in non-production runs.
 *
 * This is the ONLY file (alongside a future `../square.ts` low-level driver) where
 * Square SDK types may appear once the SDK is added; nothing Square-shaped leaks
 * past the interface in `./types.ts` — the same containment contract as Stripe.
 *
 * MONEY UNITS: the platform-wide convention is integer USD cents, which is exactly
 * Square's `Money.amount` unit for USD (the smallest currency denomination). No
 * conversion is needed, but the conversion point is centralized in `toSquareMoney`
 * so a non-cent currency would have one place to change.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Square } from 'square';
import { PaymentProviderError } from './types.js';
import type {
  ChargeOutcome,
  ClientPaymentConfig,
  NormalizedPaymentEvent,
  ParsedWebhook,
  PaymentProvider,
  ProviderChargeInput,
  ProviderRefundInput,
  RefundOutcome,
  SettledChargeResult,
} from './types.js';
import {
  getSquareClient,
  moneyToCents,
  toSquareError,
  toSquareMoney as toSquareMoneyBig,
  SquarePaymentError,
} from '../square.js';

/** USD is the only supported settlement currency for now (matches the Stripe driver). */
const CURRENCY = 'USD';

/**
 * Verify a Square webhook signature synchronously. Square computes
 * `base64( HMAC-SHA256( notificationUrl + requestBody, signatureKey ) )` and sends
 * it in the `x-square-hmacsha256-signature` header — this is byte-for-byte what the
 * SDK's `WebhooksHelper.verifySignature(...)` does (that helper is async-only in
 * v46, so we reproduce its algorithm here to keep the seam's sync contract). Uses a
 * timing-safe comparison. Returns false (never throws) on any mismatch or malformed
 * signature so the caller can fail closed with a clean 401.
 */
function verifySquareSignature(
  rawBody: string,
  signatureHeader: string,
  signatureKey: string,
  notificationUrl: string,
): boolean {
  try {
    const expected = createHmac('sha256', signatureKey)
      .update(notificationUrl + rawBody)
      .digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Thrown by every method whose live behavior still needs the Square SDK + real API
 * call wired in. A 501 so routes surface it exactly like "payments not configured"
 * rather than reporting a charge that never happened as a success. The message is
 * deliberately unambiguous so it can never be mistaken for a decline.
 */
export class SquareNotConfiguredError extends PaymentProviderError {
  constructor(detail?: string) {
    super(
      `Square live integration not configured${detail ? `: ${detail}` : ''}`,
      501,
      'square_not_configured',
    );
    this.name = 'SquareNotConfiguredError';
  }
}

/** The key material one Square provider instance runs on. */
export interface SquareProviderConfig {
  /** Square access token (secret) — the server-side credential. Server-only. */
  accessToken: string;
  /** Square Application ID — public, needed by the browser Web Payments SDK. */
  applicationId: string | null;
  /** Square Location ID the payment is attributed to — public. Required to charge. */
  locationId: string | null;
  /** Webhook signature key — enables webhook signature verification when present. */
  webhookSignatureKey: string | null;
  /**
   * The EXACT absolute URL registered as the webhook subscription's notification
   * endpoint in the Square dashboard. Square signs `HMAC-SHA256(notificationUrl +
   * rawBody)`, so verification fails unless this matches byte-for-byte. Required
   * (alongside the signature key) for the signed webhook path to accept anything.
   */
  webhookNotificationUrl: string | null;
  /** Which Square environment the keys belong to. Drives the client SDK load + API host. */
  environment: 'sandbox' | 'production';
}

/**
 * Read the platform-wide Square configuration from the process env. Returns null
 * when no access token is present (Square is simply not configured). Mirrors
 * `envStripeConfig` in stripe-provider.ts.
 */
export function envSquareConfig(): SquareProviderConfig | null {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN?.trim();
  if (!accessToken) return null;
  const rawEnv = process.env.SQUARE_ENVIRONMENT?.trim().toLowerCase();
  return {
    accessToken,
    applicationId:
      process.env.NEXT_PUBLIC_SQUARE_APPLICATION_ID?.trim() ||
      process.env.SQUARE_APPLICATION_ID?.trim() ||
      null,
    locationId:
      process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID?.trim() ||
      process.env.SQUARE_LOCATION_ID?.trim() ||
      null,
    webhookSignatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim() || null,
    webhookNotificationUrl: process.env.SQUARE_WEBHOOK_NOTIFICATION_URL?.trim() || null,
    environment: rawEnv === 'production' ? 'production' : 'sandbox',
  };
}

/**
 * Convert the platform's integer-cents amount into Square's `Money` shape. For USD,
 * Square's smallest unit IS the cent, so the integer passes through unchanged.
 * Centralized so a non-cent currency has exactly one place to adjust. Validates the
 * amount the same way the Stripe/sandbox drivers do.
 */
export function toSquareMoney(amountCents: number): { amount: number; currency: string } {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new PaymentProviderError('Charge amount must be a positive integer (cents)', 400);
  }
  return { amount: amountCents, currency: CURRENCY };
}

/**
 * Normalize one Square webhook event to our ledger's event list (empty = ignored).
 * Implemented against Square's documented v2 webhook JSON shape so it is ready the
 * moment real deliveries arrive — it does not need the SDK, only the parsed body.
 *
 * Square event types we react to:
 *   - payment.updated  -> payment_succeeded / payment_failed (by payment.status),
 *                         AND refund_completed when the payment carries a cumulative
 *                         `refunded_money` (see CUMULATIVE note below).
 *   - refund.updated   -> refund_completed (this refund's amount as a monotonic floor).
 *
 * CUMULATIVE refunded total: unlike Stripe (which sends the charge's running
 * `amount_refunded` on `charge.refunded`), Square's `refund` webhook object carries
 * only THIS refund's amount. Square fires a `payment.updated` alongside every refund
 * whose `payment.refunded_money` IS the cumulative total, so we take the cumulative
 * from there. The `refund.updated` path still emits this refund's amount as a floor;
 * the ledger (webhooks.ts) applies `max(stored, event.refundedTotalCents)` so the two
 * event streams converge monotonically and idempotently under retries.
 */
export function normalizeSquareEvent(event: {
  type?: unknown;
  data?: { object?: Record<string, unknown> };
}): NormalizedPaymentEvent[] {
  const object = event.data?.object ?? {};
  const centsOf = (money: unknown): number => {
    if (money && typeof money === 'object') {
      const amount = (money as Record<string, unknown>).amount;
      // Square v2 webhook JSON serializes Money.amount as a number of cents.
      if (typeof amount === 'number') return amount;
      if (typeof amount === 'string' && /^\d+$/.test(amount)) return Number(amount);
    }
    return 0;
  };
  switch (event.type) {
    case 'payment.updated':
    case 'payment.created': {
      const payment =
        object.payment && typeof object.payment === 'object'
          ? (object.payment as Record<string, unknown>)
          : object;
      const paymentRef = typeof payment.id === 'string' ? payment.id : null;
      if (!paymentRef) return [];
      const status = typeof payment.status === 'string' ? payment.status : '';
      const events: NormalizedPaymentEvent[] = [];
      if (status === 'COMPLETED' || status === 'APPROVED') {
        events.push({ type: 'payment_succeeded', paymentRef });
      } else if (status === 'FAILED' || status === 'CANCELED') {
        events.push({ type: 'payment_failed', paymentRef });
      }
      // CUMULATIVE source: the payment's `refunded_money` is the running total.
      const refundedTotalCents = centsOf(payment.refunded_money);
      if (refundedTotalCents > 0) {
        events.push({ type: 'refund_completed', paymentRef, refundedTotalCents });
      }
      return events;
    }
    case 'refund.updated':
    case 'refund.created': {
      const refund =
        object.refund && typeof object.refund === 'object'
          ? (object.refund as Record<string, unknown>)
          : object;
      const status = typeof refund.status === 'string' ? refund.status : '';
      if (status !== 'COMPLETED') return [];
      const paymentRef = typeof refund.payment_id === 'string' ? refund.payment_id : null;
      if (!paymentRef) return [];
      // This refund's amount only — a monotonic FLOOR. The paired `payment.updated`
      // (above) carries the true cumulative; the ledger's max() reconciles them.
      const amount = centsOf(refund.amount_money);
      return [{ type: 'refund_completed', paymentRef, refundedTotalCents: amount }];
    }
    default:
      return [];
  }
}

/** Pull the settled-charge fields off a succeeded Square Payment. */
function settledFromPayment(payment: Square.Payment, fallbackCents: number): SettledChargeResult {
  const card = payment.cardDetails?.card ?? null;
  const settledCents = moneyToCents(payment.amountMoney);
  return {
    paymentRef: payment.id ?? '',
    amountCents: settledCents > 0 ? settledCents : fallbackCents,
    cardBrand: card?.cardBrand ?? null,
    cardLastFour: card?.last4 ?? null,
    cardholderName: card?.cardholderName ?? null,
    receiptUrl: payment.receiptUrl ?? null,
  };
}

/** Build a Square-backed PaymentProvider bound to one set of keys. */
export function createSquareProvider(config: SquareProviderConfig): PaymentProvider {
  const client = () => getSquareClient(config.accessToken, config.environment);

  return {
    providerKey: 'square',

    // A Square install needs the server access token AND a location to charge
    // against. Without a location, Square cannot attribute the payment.
    isConfigured: () => Boolean(config.accessToken && config.locationId),

    clientConfig(): ClientPaymentConfig {
      // The browser needs both the application id and the location id to mount the
      // Square Web Payments card form. Missing either = cannot collect a card
      // client-side; say so rather than half-working (mirrors the Stripe driver).
      if (!config.applicationId || !config.locationId) return { kind: 'none' };
      return {
        kind: 'square-web-payments',
        applicationId: config.applicationId,
        locationId: config.locationId,
        environment: config.environment,
      };
    },

    async charge(input: ProviderChargeInput): Promise<ChargeOutcome> {
      // Real validation runs now — a bad amount is a 400 failure outcome, not a
      // thrown config error, exactly like the other drivers.
      if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
        return {
          status: 'failed',
          failure: {
            message: 'Charge amount must be a positive integer (cents)',
            code: null,
            httpStatus: 400,
          },
        };
      }
      if (!config.locationId) {
        return {
          status: 'failed',
          failure: {
            message: 'Square location is not configured; cannot take payment.',
            code: 'square_not_configured',
            httpStatus: 501,
          },
        };
      }

      // Amount + idempotency are derived here so the only remaining work is the call.
      // The SDK models Money.amount as a bigint; toSquareMoneyBig widens the cents.
      const amountMoney = toSquareMoneyBig(input.amountCents);

      let payment: Square.Payment | undefined;
      try {
        const response = await client().payments.create({
          sourceId: input.tokenizedSource, // the Web Payments card nonce
          idempotencyKey: input.idempotencyKey,
          amountMoney,
          locationId: config.locationId,
          referenceId: input.orderId,
          note: `Order ${input.orderId}`,
        });
        payment = response.payment;
      } catch (err) {
        const mapped = toSquareError(err);
        return {
          status: 'failed',
          failure: { message: mapped.message, code: mapped.code ?? null, httpStatus: mapped.status },
        };
      }

      const status = payment?.status ?? '';
      // Square card payments do NOT return a Stripe-style `requires_action` 3DS
      // intent on the server; Square runs Strong Customer Authentication in the
      // browser via `payments.verifyBuyer(...)` BEFORE tokenizing, so the server
      // charge path has no challenge branch — it is COMPLETED/APPROVED or a decline.
      if (payment && (status === 'COMPLETED' || status === 'APPROVED')) {
        return { status: 'succeeded', ...settledFromPayment(payment, input.amountCents) };
      }

      // An expected decline (e.g. status FAILED / CANCELED, or a payment the API
      // declined) is a 402 FAILED outcome — NOT a throw. Only true faults throw.
      return {
        status: 'failed',
        failure: {
          message: 'The card was declined. Please try a different card.',
          code: status || 'declined',
          httpStatus: 402,
        },
      };
    },

    async confirmChallenge({ action }): Promise<SettledChargeResult | null> {
      // Square performs SCA/3DS in the browser (payments.verifyBuyer) before the
      // card is tokenized, so there is no server-side intent to re-confirm the way
      // Stripe has. 'cancel' is therefore a no-op that resolves null (nothing to
      // release); 'complete' has no meaning for Square and is a config/logic error
      // until a flow that needs it exists.
      if (action === 'cancel') return null;
      // TODO(square-golive): Square's standard card flow has no server-side
      //   challenge-completion step. If a future flow needs one (e.g. a deferred
      //   capture or an ACH/Gift-card method that Square confirms asynchronously),
      //   implement it here against the relevant Square API. Until then this path is
      //   unreachable in a correctly wired Square install.
      throw new SquareNotConfiguredError('confirmChallenge(complete) is not applicable to Square');
    },

    // Square holds no client-recoverable server-side intent for the card flow, so —
    // like the Stripe driver — there is no local pending-challenge lookup. (Safe to
    // implement now: it is a real, correct `null`, not a stub throw.)
    async pendingChallenge(): Promise<string | null> {
      return null;
    },

    async refund(input: ProviderRefundInput): Promise<RefundOutcome> {
      // Validate now (throws like the other drivers on a bad amount). The SDK models
      // Money.amount as a bigint; toSquareMoneyBig widens the cents.
      const amountMoney = toSquareMoneyBig(input.amountCents);

      let refund: Square.PaymentRefund | undefined;
      try {
        const response = await client().refunds.refundPayment({
          idempotencyKey: `refund-${input.paymentRef}-${input.amountCents}`,
          paymentId: input.paymentRef,
          amountMoney,
          reason: input.reason, // Square accepts free-text here
        });
        refund = response.refund;
      } catch (err) {
        throw toSquareError(err);
      }

      if (!refund) {
        throw new SquarePaymentError('Square returned no refund for the request', 502);
      }
      // Square returns PENDING / COMPLETED / REJECTED / FAILED; lower-case to the
      // seam's 'succeeded'/'pending' convention (COMPLETED -> succeeded).
      const raw = (refund.status ?? 'pending').toLowerCase();
      const status = raw === 'completed' ? 'succeeded' : raw;
      const refundedCents = moneyToCents(refund.amountMoney);
      return {
        refundRef: refund.id,
        status,
        amountCents: refundedCents > 0 ? refundedCents : input.amountCents,
      };
    },

    verifyAndParseWebhook(rawBody, header): ParsedWebhook {
      // PARSING + normalization are real and run now. Only the SIGNATURE CHECK needs
      // Square's HMAC verification wired in — and crucially, when a signature key IS
      // configured we must NOT silently accept an unverified body, so that path
      // throws until the real verification is wired. Without a key we parse
      // unverified (dev parity with the Stripe driver).
      if (config.webhookSignatureKey) {
        const signature = header('x-square-hmacsha256-signature');
        if (!signature) {
          throw new PaymentProviderError('Missing Square webhook signature', 401, 'square');
        }
        // The notification URL is part of the signed payload. Without the exact
        // registered URL we CANNOT verify, and must never accept unverified — fail
        // closed with a config error rather than letting a forged body through.
        if (!config.webhookNotificationUrl) {
          throw new SquareNotConfiguredError(
            'SQUARE_WEBHOOK_NOTIFICATION_URL is required to verify signed webhooks',
          );
        }
        // Square signs base64( HMAC-SHA256( notificationUrl + rawBody, signatureKey) )
        // and sends it in `x-square-hmacsha256-signature`. This is exactly what
        // `WebhooksHelper.verifySignature(...)` computes — we reproduce it with
        // node:crypto because the seam's verifyAndParseWebhook is synchronous while
        // the v46 helper is async-only. Fail closed (401) on any mismatch.
        if (!verifySquareSignature(rawBody, signature, config.webhookSignatureKey, config.webhookNotificationUrl)) {
          throw new PaymentProviderError('Invalid Square signature', 401, 'square');
        }
      }

      // Dev / no-secret path: parse unverified (JSON.parse throws -> route 400s),
      // then normalize structurally. This is genuinely implemented, not a stub.
      const event = JSON.parse(rawBody) as {
        event_id?: unknown;
        type?: unknown;
        data?: { object?: Record<string, unknown> };
      };
      return {
        providerEventId: typeof event.event_id === 'string' ? event.event_id : null,
        providerEventType: typeof event.type === 'string' ? event.type : null,
        events: normalizeSquareEvent(event),
      };
    },
  };
}
