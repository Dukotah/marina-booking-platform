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

/** USD is the only supported settlement currency for now (matches the Stripe driver). */
const CURRENCY = 'USD';

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
 *   - payment.updated  -> payment_succeeded / payment_failed (by payment.status)
 *   - refund.updated   -> refund_completed (cumulative is derived from the payment,
 *                         so we surface the refund's own amount and let the ledger
 *                         accumulate; Square does not send a running total on the
 *                         refund object the way Stripe does on the charge).
 */
export function normalizeSquareEvent(event: {
  type?: unknown;
  data?: { object?: Record<string, unknown> };
}): NormalizedPaymentEvent[] {
  const object = event.data?.object ?? {};
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
      if (status === 'COMPLETED' || status === 'APPROVED') {
        return [{ type: 'payment_succeeded', paymentRef }];
      }
      if (status === 'FAILED' || status === 'CANCELED') {
        return [{ type: 'payment_failed', paymentRef }];
      }
      return [];
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
      const money =
        refund.amount_money && typeof refund.amount_money === 'object'
          ? (refund.amount_money as Record<string, unknown>)
          : {};
      const amount = typeof money.amount === 'number' ? money.amount : 0;
      // NOTE: Square's refund object carries THIS refund's amount, not the running
      // cumulative total Stripe sends. Until the live integration reconciles the
      // cumulative from the parent payment, we surface this refund's amount. The
      // go-live step below documents fetching the payment for the true cumulative.
      // TODO(square-golive): resolve the CUMULATIVE refunded total for `paymentRef`
      //   via Square `PaymentsApi.getPayment(paymentRef)` (sum of refunded_money) so
      //   the ledger stays idempotent/monotonic under webhook retries, matching the
      //   Stripe driver's `charge.amount_refunded` semantics.
      return [{ type: 'refund_completed', paymentRef, refundedTotalCents: amount }];
    }
    default:
      return [];
  }
}

/** Build a Square-backed PaymentProvider bound to one set of keys. */
export function createSquareProvider(config: SquareProviderConfig): PaymentProvider {
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
      const amountMoney = toSquareMoney(input.amountCents);
      void amountMoney;
      void CURRENCY;

      // TODO(square-golive): create the payment with the Square SDK —
      //   `new SquareClient({ token: config.accessToken, environment: config.environment })`
      //   then `client.payments.create({
      //     sourceId: input.tokenizedSource,   // the Web Payments card nonce
      //     idempotencyKey: input.idempotencyKey,
      //     amountMoney,                        // { amount: input.amountCents, currency: 'USD' }
      //     locationId: config.locationId,
      //     referenceId: input.orderId,
      //     note: `Order ${input.orderId}`,
      //   })`.
      //   Then map the Square `Payment` to the seam's ChargeOutcome:
      //     - status COMPLETED/APPROVED -> { status: 'succeeded', ...settledFromPayment }
      //       (paymentRef = payment.id, amountCents = payment.amountMoney.amount,
      //        cardBrand/cardLastFour/cardholderName from payment.cardDetails.card,
      //        receiptUrl = payment.receiptUrl)
      //     - a declined / failed payment -> { status: 'failed', failure: {...402...} }
      //   Square card payments do NOT return a Stripe-style `requires_action` 3DS
      //   intent on the server; Square runs Strong Customer Authentication in the
      //   browser via `payments.verifyBuyer(...)` BEFORE tokenizing, so the server
      //   charge path has no challenge branch to implement here.
      //   Map Square ApiErrors through a `toSquareError(err)` helper (to be added in
      //   `../square.ts`, mirroring `toPaymentError` in `../stripe.ts`).
      throw new SquareNotConfiguredError('payments.create is not wired');
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
      // Validate now (throws like the other drivers on a bad amount).
      const amountMoney = toSquareMoney(input.amountCents);
      void amountMoney;

      // TODO(square-golive): refund via the Square SDK —
      //   `client.refunds.refundPayment({
      //     idempotencyKey: `refund-${input.paymentRef}-${input.amountCents}`,
      //     paymentId: input.paymentRef,
      //     amountMoney,                      // { amount: input.amountCents, currency: 'USD' }
      //     reason: input.reason,             // Square accepts free-text here
      //   })`.
      //   Map the returned Square `Refund` to RefundOutcome:
      //     { refundRef: refund.id, status: refund.status (lower-cased to match the
      //       seam's 'succeeded'/'pending' convention — Square returns
      //       PENDING/COMPLETED/REJECTED/FAILED), amountCents: refund.amountMoney.amount }
      //   Throw a mapped SquarePaymentError on refusal.
      throw new SquareNotConfiguredError('refunds.refundPayment is not wired');
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
        // TODO(square-golive): verify the signature. Square signs
        //   HMAC-SHA256( notificationUrl + rawBody, webhookSignatureKey ) and sends
        //   it base64 in the `x-square-hmacsha256-signature` header. Use the Square
        //   SDK's `WebhooksHelper.verifySignature({ requestBody: rawBody, signatureHeader:
        //   signature, signatureKey: config.webhookSignatureKey, notificationUrl })`
        //   (notificationUrl is this endpoint's absolute public URL). Throw
        //   `new PaymentProviderError('Invalid Square signature', 401)` on mismatch.
        //   Do NOT remove this throw before the real check is in place — accepting an
        //   unverified signed webhook would let anyone post a fake "payment_succeeded".
        throw new SquareNotConfiguredError('webhook signature verification is not wired');
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
