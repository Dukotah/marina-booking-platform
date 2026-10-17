/**
 * Square low-level driver support — client construction and the error/result
 * mapping the Square provider shares. Mirrors `./stripe.ts`: this is the ONLY place
 * (with `./payments/square-provider.ts`) where the Square SDK's own types are
 * allowed to appear, so nothing Square-shaped leaks past the provider seam.
 *
 * Keys come from the resolver (`./payments/index.ts`) via `envSquareConfig()`.
 *
 * All amounts crossing this boundary are integer USD cents (the platform-wide
 * money convention) — which is exactly Square's `Money.amount` unit for USD. The
 * one wrinkle is that the Square v46 SDK models `Money.amount` as a `bigint`, so
 * the cents<->bigint conversion is centralized here in `toSquareMoney`.
 */
import { SquareClient, SquareEnvironment, SquareError } from 'square';
import { PaymentProviderError } from './payments/types.js';

/** USD is the only supported settlement currency for now (matches the Stripe driver). */
export const SQUARE_CURRENCY = 'USD';

/**
 * Thrown when a Square API call fails. Carries an HTTP-ish status and a clean,
 * customer-safe message so routes can turn it straight into JSON without leaking
 * SDK internals or stack traces. Extends PaymentProviderError so provider-agnostic
 * callers catch it without knowing Square exists (mirrors StripePaymentError).
 */
export class SquarePaymentError extends PaymentProviderError {
  constructor(message: string, status = 502, code?: string) {
    super(message, status, code);
    this.name = 'SquarePaymentError';
  }
}

/** One client per (token, environment). Keyed so a rotated key gets a fresh client. */
const clientCache = new Map<string, SquareClient>();

/**
 * Lazily construct (and memoize) a Square client for a given access token +
 * environment. The v46 SDK takes `{ token, environment }`; environment selects the
 * connect.squareup.com (production) vs connect.squareupsandbox.com (sandbox) host.
 */
export function getSquareClient(token: string, environment: 'sandbox' | 'production'): SquareClient {
  const cacheKey = `${environment}:${token}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;
  const client = new SquareClient({
    token,
    environment:
      environment === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
  });
  clientCache.set(cacheKey, client);
  return client;
}

/**
 * Convert the platform's integer-cents amount into Square's `Money` shape. For USD,
 * Square's smallest unit IS the cent, so the integer passes through — but the v46
 * SDK types `amount` as a `bigint`, so we widen it here. Validates the amount the
 * same way the Stripe/sandbox drivers do.
 */
export function toSquareMoney(amountCents: number): { amount: bigint; currency: 'USD' } {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new PaymentProviderError('Charge amount must be a positive integer (cents)', 400);
  }
  return { amount: BigInt(amountCents), currency: SQUARE_CURRENCY };
}

/** Narrow a Square `Money` back to integer cents (bigint → number), 0 when absent. */
export function moneyToCents(money: { amount?: bigint | null } | null | undefined): number {
  const amount = money?.amount;
  return typeof amount === 'bigint' ? Number(amount) : 0;
}

/**
 * Convert a Square failure into a clean SquarePaymentError. Mirrors
 * `toPaymentError` in stripe.ts: card declines and other payment-level problems are
 * the customer's problem (402); auth/permission faults are a server-side config
 * problem (502); everything else falls back to the SDK status.
 */
export function toSquareError(err: unknown): SquarePaymentError {
  if (err instanceof SquarePaymentError) return err;
  if (err instanceof SquareError) {
    const first = err.errors?.[0];
    const code = typeof first?.code === 'string' ? first.code : undefined;
    const detail = typeof first?.detail === 'string' ? first.detail : undefined;
    const category = first?.category;
    // PAYMENT_METHOD_ERROR covers card declines, CVV/expiry problems, etc. — the
    // customer's problem (402). 401/403 are credential/permission faults (502).
    const status =
      category === 'PAYMENT_METHOD_ERROR'
        ? 402
        : err.statusCode === 401 || err.statusCode === 403
          ? 502
          : err.statusCode ?? 502;
    return new SquarePaymentError(detail || err.message || 'Square request failed', status, code);
  }
  return new SquarePaymentError('Unexpected payment processing error', 502);
}
