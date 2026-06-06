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
 * PaymentIntent with that payment method in one synchronous call.
 *
 * 3-D Secure / SCA: when the confirmed PaymentIntent comes back `requires_action`
 * (the bank wants the cardholder to complete a challenge) we do NOT treat it as a
 * decline. `createPayment` instead returns a discriminated `requires_action`
 * result carrying the PaymentIntent's `client_secret`; the route relays it to the
 * browser, which runs `stripe.handleNextAction({ clientSecret })` to show the 3DS
 * modal, then calls the confirm endpoint to finalize. Genuine declines
 * (`requires_payment_method`, card errors, etc.) still error as before. See
 * `confirmPaymentIntent` for the post-challenge finalize read.
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

/**
 * A settled charge — the PaymentIntent reached `succeeded` and the routes can
 * record a Payment row from it. `kind: 'succeeded'` discriminates it from the
 * 3DS-pending shape below.
 */
export interface StripePaymentSucceeded {
  kind: 'succeeded';
  paymentId: string;
  status: string;
  amountCents: number;
  cardBrand: string | null;
  cardLastFour: string | null;
  cardholderName: string | null;
  receiptUrl: string | null;
}

/**
 * A PaymentIntent that needs a browser 3-D Secure / SCA challenge before it can
 * settle. Carries the `client_secret` the browser feeds to
 * `stripe.handleNextAction()` and the intent id the confirm endpoint retrieves to
 * finalize. No Payment row is recorded for this state — the money isn't captured
 * yet.
 */
export interface StripePaymentRequiresAction {
  kind: 'requires_action';
  paymentIntentId: string;
  clientSecret: string;
  amountCents: number;
}

/**
 * Discriminated result of `createPayment`. Branch on `kind`. (Genuine declines do
 * not appear here — they throw `StripePaymentError`.)
 */
export type StripePaymentResult = StripePaymentSucceeded | StripePaymentRequiresAction;

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
 * Map a `succeeded` PaymentIntent (with `latest_charge` expanded) into our
 * normalized success shape. Shared by `createPayment` (synchronous success) and
 * `confirmPaymentIntent` (post-3DS finalize) so both record identical Payment data.
 * `fallbackAmountCents` is used only if Stripe omits `amount_received`.
 */
function toSucceededResult(
  intent: Stripe.PaymentIntent,
  fallbackAmountCents: number,
): StripePaymentSucceeded {
  const charge =
    intent.latest_charge && typeof intent.latest_charge !== 'string'
      ? intent.latest_charge
      : null;
  const card = charge?.payment_method_details?.card ?? null;

  return {
    kind: 'succeeded',
    paymentId: intent.id,
    status: intent.status,
    amountCents:
      typeof intent.amount_received === 'number' && intent.amount_received > 0
        ? intent.amount_received
        : fallbackAmountCents,
    cardBrand: card?.brand ?? null,
    cardLastFour: card?.last4 ?? null,
    cardholderName: charge?.billing_details?.name ?? null,
    receiptUrl: charge?.receipt_url ?? null,
  };
}

/**
 * True when an intent is mid-3DS: either Stripe is explicitly asking for client
 * action, or it needs confirmation but has already attached a `next_action`.
 */
function intentNeedsAction(intent: Stripe.PaymentIntent): boolean {
  return (
    intent.status === 'requires_action' ||
    (intent.status === 'requires_confirmation' && Boolean(intent.next_action))
  );
}

/**
 * Charge a card. `sourceId` is the PaymentMethod id produced client-side by
 * Stripe.js / Elements. `idempotencyKey` makes retries safe.
 *
 * Returns a discriminated result: `{ kind: 'succeeded', ... }` when the charge
 * settled outright, or `{ kind: 'requires_action', clientSecret, ... }` when the
 * card needs a 3-D Secure / SCA challenge (the caller relays the client secret to
 * the browser to complete it). Genuine declines throw `StripePaymentError`.
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

    // 3-D Secure / SCA: surface a structured result instead of throwing, so the
    // browser can run the challenge and then finalize via /confirm. The intent's
    // client_secret is the credential the browser needs for handleNextAction.
    if (intentNeedsAction(intent)) {
      if (!intent.client_secret) {
        // Shouldn't happen for a card intent that needs action, but guard so we
        // never hand the client an unusable shape.
        throw new StripePaymentError('Payment requires authentication but is missing its client secret.', 502);
      }
      return {
        kind: 'requires_action',
        paymentIntentId: intent.id,
        clientSecret: intent.client_secret,
        amountCents: input.amountCents,
      };
    }

    if (intent.status !== 'succeeded') {
      // requires_payment_method (declined), canceled, etc. — a real decline.
      throw new StripePaymentError(
        'The card was declined. Please try a different card.',
        402,
        intent.status,
      );
    }

    return toSucceededResult(intent, input.amountCents);
  } catch (err) {
    throw toPaymentError(err);
  }
}

/**
 * Post-3DS finalize read: retrieve a PaymentIntent (after the browser completed
 * the challenge) and normalize it. Returns the same discriminated union as
 * `createPayment`:
 *   - `succeeded`         → caller records the Payment row,
 *   - `requires_action`   → still pending (browser must complete the challenge),
 *   - otherwise throws    → treated as a decline/failure by the caller.
 *
 * This performs a read (retrieve), not a confirm — Stripe.js already confirmed the
 * intent in the browser via handleNextAction; we only need the authoritative state.
 */
export async function confirmPaymentIntent(input: {
  paymentIntentId: string;
  fallbackAmountCents: number;
}): Promise<StripePaymentResult> {
  const stripe = getStripeClient();
  try {
    const intent = await stripe.paymentIntents.retrieve(input.paymentIntentId, {
      expand: ['latest_charge'],
    });

    if (intent.status === 'succeeded') {
      return toSucceededResult(intent, input.fallbackAmountCents);
    }

    if (intentNeedsAction(intent)) {
      if (!intent.client_secret) {
        throw new StripePaymentError('Payment requires authentication but is missing its client secret.', 502);
      }
      return {
        kind: 'requires_action',
        paymentIntentId: intent.id,
        clientSecret: intent.client_secret,
        amountCents: input.fallbackAmountCents,
      };
    }

    // requires_payment_method / canceled / processing-stuck → treat as failed.
    throw new StripePaymentError(
      'The payment could not be completed. Please try a different card.',
      402,
      intent.status,
    );
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
