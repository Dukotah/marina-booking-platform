/**
 * Stripe payments service (PaymentIntents, sandbox/test-first).
 *
 * Thin, framework-agnostic wrapper around the Stripe Node SDK that the payments
 * routes call. It deliberately does NOT touch the database — the routes own the
 * Payment/Order/OrderEvent writes so they stay inside one tenant-scoped
 * transaction. This module only talks to Stripe and normalizes its results and
 * errors into plain shapes the routes can serialize to JSON.
 *
 * Configuration comes entirely from env:
 *   - STRIPE_SECRET_KEY   (required; if missing the platform is "not configured")
 *   - STRIPE_WEBHOOK_SECRET (optional; enables webhook signature verification)
 *
 * Charge model: the browser collects a card with Stripe.js / Elements and creates
 * a PaymentMethod, whose id is sent to us as `sourceId`. We create + confirm a
 * PaymentIntent with that payment method in one synchronous call. Cards that
 * require 3-D Secure / SCA would come back `requires_action`; we treat anything
 * other than `succeeded` as a decline for now (full SCA handling is a follow-up).
 *
 * All amounts crossing this boundary are integer USD cents (the platform-wide
 * money convention) — which is exactly Stripe's unit, so no conversion is needed.
 */
import Stripe from 'stripe';

/** USD is the only supported settlement currency for now. */
const CURRENCY = 'usd';

/**
 * Thrown when a Stripe API call fails. Carries an HTTP-ish status and a clean,
 * customer-safe message so routes can turn it straight into JSON without leaking
 * SDK internals or stack traces.
 */
export class StripePaymentError extends Error {
  readonly status: number;
  /** Stripe's machine-readable error code, when available. */
  readonly code?: string;
  constructor(message: string, status = 502, code?: string) {
    super(message);
    this.name = 'StripePaymentError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Thrown (and surfaced as 501) when Stripe credentials are not configured. Lets
 * the rest of the app boot and run without payments wired up.
 */
export class StripeNotConfiguredError extends Error {
  readonly status = 501;
  constructor() {
    super('payments not configured');
    this.name = 'StripeNotConfiguredError';
  }
}

/** True when a Stripe secret key is present in the environment. */
export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

let cachedClient: Stripe | null = null;
let cachedKey: string | null = null;

/**
 * Lazily construct (and memoize) the Stripe client, keyed on the secret so a
 * rotated key in dev is picked up without a restart.
 */
export function getStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeNotConfiguredError();
  if (cachedClient && cachedKey === key) return cachedClient;
  // Pin nothing here — the installed SDK's default apiVersion is fine.
  cachedClient = new Stripe(key);
  cachedKey = key;
  return cachedClient;
}

/** Normalized payment result the routes persist. */
export interface StripePaymentResult {
  paymentId: string;
  status: string;
  amountCents: number;
  cardBrand: string | null;
  cardLastFour: string | null;
  cardholderName: string | null;
  receiptUrl: string | null;
}

/** Normalized refund result the routes persist. */
export interface StripeRefundResult {
  refundId: string;
  status: string;
  amountCents: number;
}

/** Convert a Stripe failure into a clean StripePaymentError. */
function toPaymentError(err: unknown): StripePaymentError {
  if (err instanceof StripePaymentError) return err;
  if (err instanceof Stripe.errors.StripeError) {
    const code = err.code;
    // Card declines are the customer's problem (402); auth/permission errors are
    // a server-side configuration problem (502); fall back to the SDK status.
    const status =
      err.type === 'StripeCardError'
        ? 402
        : err.statusCode === 401 || err.statusCode === 403
          ? 502
          : err.statusCode ?? 502;
    return new StripePaymentError(err.message || 'Stripe request failed', status, code);
  }
  return new StripePaymentError('Unexpected payment processing error', 502);
}

/**
 * Charge a card. `sourceId` is the PaymentMethod id produced client-side by
 * Stripe.js / Elements. `idempotencyKey` makes retries safe.
 */
export async function createPayment(input: {
  orderId: string;
  sourceId: string;
  amountCents: number;
  idempotencyKey: string;
}): Promise<StripePaymentResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new StripePaymentError('Charge amount must be a positive integer (cents)', 400);
  }

  const stripe = getStripeClient();
  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: CURRENCY,
        payment_method: input.sourceId,
        confirm: true,
        // Server-side confirm with no redirect-based methods (card only for now).
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: { orderId: input.orderId },
        description: `Order ${input.orderId}`,
        expand: ['latest_charge'],
      },
      { idempotencyKey: input.idempotencyKey },
    );

    if (intent.status !== 'succeeded') {
      // requires_action (3DS), requires_payment_method (declined), etc.
      throw new StripePaymentError(
        intent.status === 'requires_action'
          ? 'This card needs additional authentication. Please try another card.'
          : 'The card was declined. Please try a different card.',
        402,
        intent.status,
      );
    }

    const charge =
      intent.latest_charge && typeof intent.latest_charge !== 'string'
        ? intent.latest_charge
        : null;
    const card = charge?.payment_method_details?.card ?? null;

    return {
      paymentId: intent.id,
      status: intent.status,
      amountCents: typeof intent.amount_received === 'number' ? intent.amount_received : input.amountCents,
      cardBrand: card?.brand ?? null,
      cardLastFour: card?.last4 ?? null,
      cardholderName: charge?.billing_details?.name ?? null,
      receiptUrl: charge?.receipt_url ?? null,
    };
  } catch (err) {
    throw toPaymentError(err);
  }
}

/**
 * Refund a previously captured payment, fully or partially. `paymentId` is the
 * Stripe PaymentIntent id (our Payment.processor_transaction_id).
 */
export async function refundPayment(input: {
  paymentId: string;
  amountCents: number;
  reason?: string;
}): Promise<StripeRefundResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new StripePaymentError('Refund amount must be a positive integer (cents)', 400);
  }

  const stripe = getStripeClient();
  try {
    const refund = await stripe.refunds.create(
      {
        payment_intent: input.paymentId,
        amount: input.amountCents,
        // Stripe only accepts a fixed reason enum; keep the free-text in metadata.
        reason: 'requested_by_customer',
        ...(input.reason ? { metadata: { note: input.reason } } : {}),
      },
      { idempotencyKey: `refund-${input.paymentId}-${input.amountCents}` },
    );

    return {
      refundId: refund.id,
      status: refund.status ?? 'pending',
      amountCents: typeof refund.amount === 'number' ? refund.amount : input.amountCents,
    };
  } catch (err) {
    throw toPaymentError(err);
  }
}

/**
 * Verify + parse a Stripe webhook. When STRIPE_WEBHOOK_SECRET is set we verify the
 * signature and throw on mismatch; when unset (dev) we parse the body unverified so
 * the flow can be exercised against the Stripe CLI without a registered endpoint.
 */
export function constructWebhookEvent(rawBody: string, signature: string | undefined): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripe = getStripeClient();
  if (!secret) {
    return JSON.parse(rawBody) as Stripe.Event; // dev: accept unverified
  }
  if (!signature) {
    throw new StripePaymentError('Missing Stripe signature', 401);
  }
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new StripePaymentError('Invalid Stripe signature', 401);
  }
}
