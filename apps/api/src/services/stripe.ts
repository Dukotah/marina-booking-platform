/**
 * Stripe low-level driver support — client construction, env detection, and the
 * error/result shapes the rest of the payment layer shares.
 *
 * HISTORY: this module used to be the whole payment service (charge/refund/webhook
 * verification with the sandbox + fake-payments dispatch inlined). That logic now
 * lives behind the provider seam in `./payments/` — `stripe-provider.ts` owns every
 * Stripe API call, `sandbox-provider.ts` owns the simulator, and `payments/index.ts`
 * picks the provider per operator. What remains here is what BOTH sides still
 * share:
 *
 *   - the error classes (`StripePaymentError` extends the provider-neutral
 *     `PaymentProviderError`, so routes catch the neutral class and every existing
 *     throw — including the sandbox simulator's — still lands),
 *   - the result shapes the sandbox simulator returns (`StripePaymentResult`),
 *   - env configuration detection (`isStripeConfigured` / `isFakePaymentsEnabled`
 *     / `arePaymentsEnabled`), and
 *   - the memoized Stripe client factory, now keyed by secret so a per-operator
 *     key from an Integration record gets its own client.
 *
 * Configuration comes from env (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET) or from
 * a per-operator `stripe` Integration record — see `payments/index.ts`.
 *
 * All amounts crossing this boundary are integer USD cents (the platform-wide
 * money convention) — which is exactly Stripe's unit, so no conversion is needed.
 */
import Stripe from 'stripe';
import { PaymentProviderError, PaymentsNotConfiguredError } from './payments/types.js';

/**
 * Thrown when a Stripe API call fails. Carries an HTTP-ish status and a clean,
 * customer-safe message so routes can turn it straight into JSON without leaking
 * SDK internals or stack traces. Extends PaymentProviderError so provider-agnostic
 * callers catch it without knowing Stripe exists.
 */
export class StripePaymentError extends PaymentProviderError {
  constructor(message: string, status = 502, code?: string) {
    super(message, status, code);
    this.name = 'StripePaymentError';
  }
}

/**
 * Thrown (and surfaced as 501) when Stripe credentials are not configured. Lets
 * the rest of the app boot and run without payments wired up.
 */
export class StripeNotConfiguredError extends PaymentsNotConfiguredError {
  constructor() {
    super();
    this.name = 'StripeNotConfiguredError';
  }
}

/** True when a Stripe secret key is present in the environment. */
export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Dev-only "fake payments" mode: when no Stripe key is configured but
 * DEV_FAKE_PAYMENTS=true (and we are NOT in production), charges/refunds are
 * simulated so the full booking flow can be dogfooded locally with no Stripe
 * account. This NEVER activates in production, even if the flag is set.
 */
export function isFakePaymentsEnabled(): boolean {
  return (
    process.env.DEV_FAKE_PAYMENTS === 'true' &&
    process.env.NODE_ENV !== 'production' &&
    !isStripeConfigured()
  );
}

/** True when payments can be taken via ENV config — real Stripe OR the dev simulator. */
export function arePaymentsEnabled(): boolean {
  return isStripeConfigured() || isFakePaymentsEnabled();
}

/** One client per secret key. Keyed so a rotated (or per-operator) key gets a fresh client. */
const clientCache = new Map<string, Stripe>();

/**
 * Lazily construct (and memoize) a Stripe client. With no argument the env
 * STRIPE_SECRET_KEY is used; `payments/index.ts` passes a per-operator key when an
 * Integration record supplies one.
 */
export function getStripeClient(secretKey?: string): Stripe {
  const key = secretKey ?? process.env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeNotConfiguredError();
  const cached = clientCache.get(key);
  if (cached) return cached;
  // Pin nothing here — the installed SDK's default apiVersion is fine.
  const client = new Stripe(key);
  clientCache.set(key, client);
  return client;
}

/** Normalized payment result the sandbox simulator returns and the ledger persists. */
export interface StripePaymentResult {
  paymentId: string;
  status: string;
  amountCents: number;
  cardBrand: string | null;
  cardLastFour: string | null;
  cardholderName: string | null;
  receiptUrl: string | null;
}

/** Normalized refund result the sandbox simulator returns. */
export interface StripeRefundResult {
  refundId: string;
  status: string;
  amountCents: number;
}

/** Convert a Stripe failure into a clean StripePaymentError. */
export function toPaymentError(err: unknown): StripePaymentError {
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
