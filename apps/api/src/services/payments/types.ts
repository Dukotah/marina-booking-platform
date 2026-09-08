/**
 * The payment-provider seam — the ONE interface the money path talks to.
 *
 * Everything a route (or the booking service) needs from a payment processor is
 * expressed here in processor-neutral terms: charge a tokenized source, finish or
 * abandon a 3-D Secure challenge, refund, verify + normalize a webhook, and tell
 * the browser what it needs to collect a card. Concrete processors implement this
 * interface in sibling files (`stripe-provider.ts`, `sandbox-provider.ts`) and are
 * chosen by the resolver in `./index.ts`. Processor SDK types must NEVER appear in
 * this file — that containment is the whole point of the seam.
 *
 * Plugging in a new processor = one new provider file here + one client
 * `PaymentMethodInput` component + a catalog entry. See docs/PAYMENTS.md.
 *
 * All amounts are integer USD cents (the platform-wide money convention).
 */

// ===========================================================================
// Errors
// ===========================================================================

/**
 * Thrown when a provider call fails in a way the caller should surface. Carries an
 * HTTP-ish status and a clean, customer-safe message so routes can turn it
 * straight into JSON without leaking SDK internals or stack traces.
 *
 * `StripePaymentError` (services/stripe.ts) extends this class, so every error the
 * existing drivers throw — including the sandbox simulator's — is already a
 * `PaymentProviderError`. Routes catch THIS class, never a processor's own.
 */
export class PaymentProviderError extends Error {
  readonly status: number;
  /** The provider's machine-readable error code, when available. */
  readonly code?: string;
  constructor(message: string, status = 502, code?: string) {
    super(message);
    this.name = 'PaymentProviderError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Thrown (and surfaced as 501) when no payment provider is configured. Lets the
 * rest of the app boot and run without payments wired up.
 */
export class PaymentsNotConfiguredError extends PaymentProviderError {
  constructor() {
    super('payments not configured', 501);
    this.name = 'PaymentsNotConfiguredError';
  }
}

/**
 * A 3DS/SCA challenge is outstanding on a charge made through the service layer
 * (deposits, balance collection), where there is no route to answer 200
 * `requiresAction`. Carries everything the eventual client needs. Routes that call
 * `charge()` directly never see this — they get the `requires_action` outcome.
 */
export class PaymentChallengeRequiredError extends PaymentProviderError {
  readonly intentId: string;
  readonly clientSecret: string;
  readonly challengeUrl: string;
  constructor(challenge: PaymentChallenge) {
    super('This payment requires additional authentication.', 402, 'requires_action');
    this.name = 'PaymentChallengeRequiredError';
    this.intentId = challenge.intentId ?? '';
    this.clientSecret = challenge.clientSecret ?? '';
    this.challengeUrl = challenge.returnUrl ?? '';
  }
}

// ===========================================================================
// Charge
// ===========================================================================

export interface ProviderChargeInput {
  /** Our order the charge settles against (goes to processor metadata). */
  orderId: string;
  /**
   * The client-side token for the payment instrument — a Stripe PaymentMethod id,
   * a sandbox placeholder, or whatever the next processor's browser SDK produces.
   * The server never sees a card number.
   */
  tokenizedSource: string;
  /** Amount to charge, integer cents, > 0. */
  amountCents: number;
  /** Stable retry key — the same key must never charge twice. */
  idempotencyKey: string;
  /**
   * Tenant hint. Required when charging from inside a transaction that created the
   * order (the sandbox driver would otherwise look the order up on a separate
   * connection and miss the uncommitted row). Real processors ignore it.
   */
  operatorId?: string;
}

/** Everything the ledger persists about a settled charge. */
export interface SettledChargeResult {
  /** The provider's durable handle on the charge (stored as processor_transaction_id). */
  paymentRef: string;
  /** What actually settled (a partial capture settles for less than authorized). */
  amountCents: number;
  cardBrand: string | null;
  cardLastFour: string | null;
  cardholderName: string | null;
  receiptUrl: string | null;
}

/** What the browser needs to get the guest through their bank's second factor. */
export interface PaymentChallenge {
  /** The provider's intent awaiting authentication — the client's handle on the attempt. */
  intentId: string | null;
  /** Stripe.js (and equivalents) need this to run the challenge in the browser. */
  clientSecret: string | null;
  returnUrl: string | null;
}

/** How a charge failed, in the shape the route serializes verbatim. */
export interface ChargeFailure {
  /** Customer-safe message. */
  message: string;
  /** Provider decline/error code, when available. */
  code: string | null;
  /** HTTP status the route should answer with (402 decline, 502 processor fault…). */
  httpStatus: number;
}

/**
 * The complete outcome of one charge attempt. Expected payment outcomes — success,
 * a bank challenge, a decline — are RETURN VALUES, not exceptions: they are the
 * processor answering the question, and each has its own route response. Only
 * configuration faults and truly unexpected failures throw.
 */
export type ChargeOutcome =
  | ({ status: 'succeeded' } & SettledChargeResult)
  | { status: 'requires_action'; amountCents: number; challenge: PaymentChallenge }
  | { status: 'failed'; failure: ChargeFailure };

// ===========================================================================
// Refund
// ===========================================================================

export interface ProviderRefundInput {
  /** The provider charge handle (our Payment.processor_transaction_id). */
  paymentRef: string;
  /** Amount to refund, integer cents, > 0. */
  amountCents: number;
  /** Free-text staff reason, forwarded where the processor accepts one. */
  reason?: string;
  /** Tenant hint — see ProviderChargeInput. */
  operatorId?: string;
}

export interface RefundOutcome {
  /** The provider's handle on the refund. */
  refundRef: string;
  /** Provider-reported refund status ('succeeded', 'pending', …). */
  status: string;
  amountCents: number;
}

// ===========================================================================
// Webhooks
// ===========================================================================

/**
 * Provider events normalized to the three facts our ledger reacts to. Everything
 * else a processor sends is intentionally ignored (and acknowledged, so it is not
 * retried at us forever).
 */
export type NormalizedPaymentEvent =
  | { type: 'payment_succeeded'; paymentRef: string }
  | { type: 'payment_failed'; paymentRef: string }
  | {
      type: 'refund_completed';
      paymentRef: string;
      /** CUMULATIVE refunded total for the charge — monotonic + idempotent under retries. */
      refundedTotalCents: number;
    };

export interface ParsedWebhook {
  /** The provider's own event id/type, for logging only. */
  providerEventId: string | null;
  providerEventType: string | null;
  events: NormalizedPaymentEvent[];
}

// ===========================================================================
// Browser config
// ===========================================================================

/**
 * What the browser needs to collect a payment method for this provider. Served by
 * GET /api/payments/config; each `kind` pairs with one client `PaymentMethodInput`
 * implementation (apps/web/components/checkout/payment-methods/).
 */
export type ClientPaymentConfig =
  | { kind: 'stripe-elements'; publishableKey: string; testMode: boolean }
  | { kind: 'sandbox' }
  | { kind: 'none' };

// ===========================================================================
// The provider interface
// ===========================================================================

export type PaymentProviderKey = 'stripe' | 'sandbox' | 'none';

export interface PaymentProvider {
  readonly providerKey: PaymentProviderKey;

  /** True when this provider can actually move (or credibly simulate) money. */
  isConfigured(): boolean;

  /** What the browser needs to collect a card for this provider. Never a secret. */
  clientConfig(): ClientPaymentConfig;

  /** Charge a tokenized source. See ChargeOutcome for the exception contract. */
  charge(input: ProviderChargeInput): Promise<ChargeOutcome>;

  /**
   * Finish an outstanding 3DS/SCA challenge.
   *   complete — settle the intent; returns the settled charge or throws a
   *     PaymentProviderError when the bank did not (yet) confirm.
   *   cancel — abandon it (best-effort where the processor expires intents on its
   *     own); resolves null and never reports "already failed" as an error.
   */
  confirmChallenge(input: {
    intentId: string;
    action: 'complete' | 'cancel';
    operatorId: string;
  }): Promise<SettledChargeResult | null>;

  /**
   * The intent of a challenge still outstanding against an order, when the
   * provider can answer that locally (the sandbox keeps its own attempt ledger;
   * real processors return null and the client must send the intent id back).
   */
  pendingChallenge(input: { orderId: string; operatorId: string }): Promise<string | null>;

  /** Refund a settled charge, fully or partially. Throws PaymentProviderError on refusal. */
  refund(input: ProviderRefundInput): Promise<RefundOutcome>;

  /**
   * Verify a webhook delivery (throws PaymentProviderError 401 on a bad
   * signature) and normalize it. The raw body must be the EXACT bytes received —
   * signatures are computed over them.
   */
  verifyAndParseWebhook(rawBody: string, header: (name: string) => string | undefined): ParsedWebhook;
}

/**
 * Narrow a charge outcome to its settled result, throwing the same errors the
 * pre-seam drivers threw. For service-layer callers (deposits, balance
 * collection) that have no way to answer a challenge mid-transaction.
 */
export function settledOrThrow(outcome: ChargeOutcome): SettledChargeResult {
  switch (outcome.status) {
    case 'succeeded':
      return outcome;
    case 'requires_action':
      throw new PaymentChallengeRequiredError(outcome.challenge);
    case 'failed':
      throw new PaymentProviderError(
        outcome.failure.message,
        outcome.failure.httpStatus,
        outcome.failure.code ?? undefined,
      );
  }
}
