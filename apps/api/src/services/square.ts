/**
 * Square payments service (SDK v38, sandbox-first).
 *
 * Thin, framework-agnostic wrapper around the Square Node SDK that the payments
 * routes call. It deliberately does NOT touch the database — the routes own the
 * Payment/Order/OrderEvent writes so they stay inside one tenant-scoped
 * transaction. This module only talks to Square and normalizes its results and
 * errors into plain shapes the routes can serialize to JSON.
 *
 * Configuration comes entirely from env:
 *   - SQUARE_ACCESS_TOKEN  (required; if missing the platform is "not configured")
 *   - SQUARE_ENVIRONMENT   ("production" | "sandbox"; defaults to "sandbox")
 *
 * All amounts crossing this boundary are integer USD cents (the platform-wide
 * money convention). Square's Money type wants a BigInt, so we convert here.
 */
import { SquareClient, SquareEnvironment, SquareError } from 'square';

/** USD is the only supported settlement currency for now. */
const CURRENCY = 'USD';

/**
 * Thrown when a Square API call fails. Carries an HTTP-ish status and a clean,
 * customer-safe message so routes can turn it straight into JSON without leaking
 * SDK internals or stack traces.
 */
export class SquarePaymentError extends Error {
  readonly status: number;
  /** Square's machine-readable error code(s), when available. */
  readonly code?: string;
  constructor(message: string, status = 502, code?: string) {
    super(message);
    this.name = 'SquarePaymentError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Thrown (and surfaced as 501) when Square credentials are not configured. Lets
 * the rest of the app boot and run without payments wired up.
 */
export class SquareNotConfiguredError extends Error {
  readonly status = 501;
  constructor() {
    super('payments not configured');
    this.name = 'SquareNotConfiguredError';
  }
}

/** True when a Square access token is present in the environment. */
export function isSquareConfigured(): boolean {
  return Boolean(process.env.SQUARE_ACCESS_TOKEN);
}

let cachedClient: SquareClient | null = null;
let cachedToken: string | null = null;

/**
 * Lazily construct (and memoize) the Square client. We key the cache on the
 * token so a rotated/changed token in dev is picked up without a restart.
 */
function getClient(): SquareClient {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new SquareNotConfiguredError();

  if (cachedClient && cachedToken === token) return cachedClient;

  const environment =
    process.env.SQUARE_ENVIRONMENT === 'production'
      ? SquareEnvironment.Production
      : SquareEnvironment.Sandbox;

  cachedClient = new SquareClient({ token, environment });
  cachedToken = token;
  return cachedClient;
}

/** Normalized payment result the routes persist. */
export interface SquarePaymentResult {
  paymentId: string;
  status: string;
  amountCents: number;
  cardBrand: string | null;
  cardLastFour: string | null;
  cardholderName: string | null;
  receiptUrl: string | null;
}

/** Normalized refund result the routes persist. */
export interface SquareRefundResult {
  refundId: string;
  status: string;
  amountCents: number;
}

/**
 * Convert a Square API failure into a clean SquarePaymentError. Square returns a
 * list of errors; we surface the first one's detail/code and map auth/validation
 * codes to sensible HTTP statuses.
 */
function toPaymentError(err: unknown): SquarePaymentError {
  if (err instanceof SquareError) {
    const first = err.errors?.[0];
    const code = first?.code;
    const detail = first?.detail ?? err.message ?? 'Square request failed';
    // 401/403 from Square almost always means bad/expired credentials — treat as
    // a server-side configuration problem rather than a client error.
    const status = err.statusCode === 401 || err.statusCode === 403 ? 502 : err.statusCode ?? 502;
    return new SquarePaymentError(detail, status, code);
  }
  if (err instanceof SquarePaymentError) return err;
  return new SquarePaymentError('Unexpected payment processing error', 502);
}

/**
 * Charge a card. `sourceId` is the payment token produced client-side by the
 * Square Web Payments SDK (a card nonce). `idempotencyKey` makes retries safe.
 */
export async function createPayment(input: {
  orderId: string;
  sourceId: string;
  amountCents: number;
  idempotencyKey: string;
}): Promise<SquarePaymentResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new SquarePaymentError('Charge amount must be a positive integer (cents)', 400);
  }

  const client = getClient();
  try {
    const res = await client.payments.create({
      sourceId: input.sourceId,
      idempotencyKey: input.idempotencyKey,
      amountMoney: {
        amount: BigInt(input.amountCents),
        currency: CURRENCY,
      },
      // Link the Square payment back to our order for reconciliation.
      referenceId: input.orderId,
      note: `Order ${input.orderId}`,
    });

    const payment = res.payment;
    if (!payment?.id) {
      throw new SquarePaymentError('Square did not return a payment', 502);
    }

    const card = payment.cardDetails?.card;
    return {
      paymentId: payment.id,
      status: payment.status ?? 'UNKNOWN',
      // Echo back what Square actually approved (defensive vs. the requested amount).
      amountCents: payment.amountMoney?.amount != null ? Number(payment.amountMoney.amount) : input.amountCents,
      cardBrand: card?.cardBrand ?? null,
      cardLastFour: card?.last4 ?? null,
      cardholderName: card?.cardholderName ?? null,
      receiptUrl: payment.receiptUrl ?? null,
    };
  } catch (err) {
    throw toPaymentError(err);
  }
}

/**
 * Refund a previously captured payment, fully or partially. `paymentId` is the
 * Square payment id (our Payment.processor_transaction_id).
 */
export async function refundPayment(input: {
  paymentId: string;
  amountCents: number;
  reason?: string;
}): Promise<SquareRefundResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new SquarePaymentError('Refund amount must be a positive integer (cents)', 400);
  }

  const client = getClient();
  try {
    const res = await client.refunds.refundPayment({
      // A fresh idempotency key per refund attempt; partial refunds are distinct ops.
      idempotencyKey: `refund-${input.paymentId}-${input.amountCents}-${Date.now()}`,
      paymentId: input.paymentId,
      amountMoney: {
        amount: BigInt(input.amountCents),
        currency: CURRENCY,
      },
      reason: input.reason,
    });

    const refund = res.refund;
    if (!refund?.id) {
      throw new SquarePaymentError('Square did not return a refund', 502);
    }

    return {
      refundId: refund.id,
      status: refund.status ?? 'PENDING',
      amountCents: refund.amountMoney?.amount != null ? Number(refund.amountMoney.amount) : input.amountCents,
    };
  } catch (err) {
    throw toPaymentError(err);
  }
}
