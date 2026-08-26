/**
 * Local payment simulator — the `local` driver of the payments provider.
 *
 * docs/LOCAL-FIRST-BUILD.md §0 says the owner must be able to exercise 100% of
 * this product with no Stripe account, and §4.1 says a local driver must be a
 * faithful simulation rather than a toy. So this module reproduces the Stripe
 * PaymentIntent state machine — 3DS challenges, real decline codes, a network
 * timeout that leaves the charge indeterminate, partial capture, partial refund
 * and a chargeback — and emits Stripe-shaped webhook events for each.
 *
 * It presents the SAME surface as `./stripe.ts` (`createPayment` /
 * `refundPayment`, returning `StripePaymentResult` / `StripeRefundResult` and
 * throwing `StripePaymentError`) so a caller cannot tell which driver it got.
 * Selection uses the one existing rule, `sandboxEnabled()` from `./sandbox.ts`.
 *
 * WHAT IT PERSISTS: only the sandbox tables — SandboxPaymentAttempt,
 * SandboxWebhook, SandboxClock. Like `stripe.ts` it never touches Order/Payment;
 * the routes own those writes so they stay inside one tenant transaction. The
 * attempt rows are this driver's substitute for Stripe's own ledger, which is
 * what lets idempotency survive a process restart.
 *
 * THE QUEUE: the Local Console writes a QUEUED SandboxPaymentAttempt ("make the
 * next card decline"); the next charge pops the oldest one, fills in intent id /
 * amount / order and advances it. With nothing queued the default is SUCCEEDED,
 * so the ordinary booking flow is never blocked on scripting an outcome.
 *
 * Money is integer cents throughout, times are UTC.
 */
import { createId } from '@marina/core';
import { adminPrisma, forOperator } from '@marina/database';
import type { Prisma, TenantClient } from '@marina/database';
import { StripePaymentError } from './stripe.js';
import type { StripePaymentResult, StripeRefundResult } from './stripe.js';
import { sandboxEnabled } from './sandbox.js';

/** USD only, matching `stripe.ts`. */
const CURRENCY = 'usd';

/** Stripe pins an API version on every event; echo a plausible one. */
const API_VERSION = '2024-06-20';

// ===========================================================================
// Types (string unions structurally identical to the Prisma enums)
// ===========================================================================

/** Mirrors `SandboxPaymentOutcome`. */
export type SandboxOutcome = 'SUCCEEDED' | 'REQUIRES_ACTION' | 'DECLINED' | 'TIMEOUT' | 'DISPUTED';

/** Mirrors `SandboxPaymentAttemptStatus`. */
export type AttemptStatus =
  | 'QUEUED'
  | 'REQUIRES_ACTION'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DISPUTED'
  | 'CANCELLED';

export const SANDBOX_OUTCOMES: readonly SandboxOutcome[] = [
  'SUCCEEDED',
  'REQUIRES_ACTION',
  'DECLINED',
  'TIMEOUT',
  'DISPUTED',
];

/** The decline codes a real card issuer actually returns, most common first. */
export const DECLINE_CODES = [
  'card_declined',
  'insufficient_funds',
  'expired_card',
  'incorrect_cvc',
] as const;
export type DeclineCode = (typeof DECLINE_CODES)[number];

/** Stripe's own customer-facing copy for each decline, verbatim in tone. */
const DECLINE_MESSAGES: Record<DeclineCode, string> = {
  card_declined: 'Your card was declined.',
  insufficient_funds: 'Your card has insufficient funds.',
  expired_card: 'Your card has expired.',
  incorrect_cvc: "Your card's security code is incorrect.",
};

/**
 * Stripe's published test cards for each outcome. Carrying the real last-four
 * through means a screenshot of the Local Console looks like a screenshot of the
 * Stripe dashboard, and anyone who knows `4000 0000 0000 9995` recognizes it.
 * Brand is lower-case because that is what Stripe sends.
 */
const TEST_CARDS: Record<string, { brand: string; last4: string }> = {
  succeeded: { brand: 'visa', last4: '4242' },
  requires_action: { brand: 'visa', last4: '3155' },
  card_declined: { brand: 'visa', last4: '0002' },
  insufficient_funds: { brand: 'visa', last4: '9995' },
  expired_card: { brand: 'visa', last4: '0069' },
  incorrect_cvc: { brand: 'visa', last4: '0127' },
};

const CARDHOLDER = 'Sandbox Tester';

/** One simulated refund, kept in the attempt's metadata. */
export interface SandboxRefund {
  id: string;
  amountCents: number;
  reason: string | null;
  /** Derived or caller-supplied; a repeat with the same key returns this refund. */
  idempotencyKey: string;
  at: string;
}

/**
 * Driver-specific detail on an attempt. Lives in the row's `metadata` Json so the
 * simulator can grow a knob without a migration, and so the console has one place
 * to read the whole story of an attempt from.
 *
 * The first three fields are INPUTS the console scripts onto a QUEUED row; the
 * rest are what the simulation recorded.
 */
export interface AttemptMetadata {
  /** Force a specific decline code instead of the deterministic pick. */
  failureCode?: DeclineCode;
  /** Capture less than the authorized amount (partial capture). */
  captureAmountCents?: number;
  /** Free-text the owner typed in the console, shown beside the row. */
  note?: string;

  sourceId?: string | null;
  authorizedCents?: number;
  capturedCents?: number;
  refundedCents?: number;
  refunds?: SandboxRefund[];
  cardBrand?: string | null;
  cardLastFour?: string | null;
  /**
   * True when the charge settled but the caller never heard back. The row is
   * SUCCEEDED (the money moved) even though `createPayment` threw — which is
   * precisely the state idempotency keys exist to recover from.
   */
  timedOut?: boolean;
  challenge?: {
    clientSecret: string;
    returnUrl: string;
    resolvedAt?: string;
    succeeded?: boolean;
  };
  dispute?: {
    id: string;
    reason: string;
    amountCents: number;
    at: string;
  };
}

/** An attempt row as this module sees it (Prisma's row with typed metadata). */
export interface SandboxAttempt {
  id: string;
  operator_id: string;
  intent_id: string | null;
  amount_cents: number | null;
  outcome: SandboxOutcome;
  status: AttemptStatus;
  order_id: string | null;
  failure_code: string | null;
  idempotency_key: string | null;
  metadata: AttemptMetadata | null;
  consumed_at: Date | null;
  created_at: Date;
}

/** A Stripe-shaped event ready to be written to SandboxWebhook. */
export interface SandboxEvent {
  type: string;
  payload: Record<string, unknown>;
}

// ===========================================================================
// Errors
// ===========================================================================

/**
 * A 3DS/SCA challenge is outstanding. Extends StripePaymentError so today's
 * routes still render it as a clean 402, while a route that wants to do the right
 * thing (LOCAL-FIRST-BUILD §5: "today anything not succeeded is a decline") can
 * `instanceof` it and hand the browser a challenge instead of a rejection.
 */
export class SandboxChallengeRequired extends StripePaymentError {
  readonly intentId: string;
  readonly clientSecret: string;
  readonly challengeUrl: string;
  constructor(intentId: string, clientSecret: string, challengeUrl: string) {
    super('This payment requires additional authentication.', 402, 'requires_action');
    this.name = 'SandboxChallengeRequired';
    this.intentId = intentId;
    this.clientSecret = clientSecret;
    this.challengeUrl = challengeUrl;
  }
}

/** The store rejected a write because the idempotency key already exists. */
export class SandboxDuplicateKeyError extends Error {
  constructor() {
    super('idempotency key already used');
    this.name = 'SandboxDuplicateKeyError';
  }
}

// ===========================================================================
// Pure helpers — no I/O, unit-tested directly
// ===========================================================================

/** True when charges should go through this simulator instead of Stripe. */
export function sandboxPaymentsEnabled(): boolean {
  return sandboxEnabled();
}

/** A PaymentIntent-shaped id that is obviously not a real one. */
export function newIntentId(): string {
  return `pi_sbx_${createId()}`;
}

/** Stripe derives the charge id separately; keep ours correlatable to the intent. */
export function chargeIdFor(intentId: string): string {
  return `ch_sbx_${intentId.replace(/^pi_sbx_/, '')}`;
}

/**
 * Pick a decline code from the caller's idempotency key.
 *
 * Deterministic on purpose: an owner who declines four bookings in a row should
 * see four different, realistic reasons rather than `card_declined` every time,
 * but a test that re-runs the same key must get the same code both times. A
 * random pick would give variety and lose reproducibility; this gives both.
 */
export function pickDeclineCode(seed: string): DeclineCode {
  let hash = 2166136261; // FNV-1a
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return DECLINE_CODES[(hash >>> 0) % DECLINE_CODES.length];
}

/** Customer-safe copy for a decline code (unknown codes fall back to the generic). */
export function declineMessage(code: string): string {
  return DECLINE_MESSAGES[code as DeclineCode] ?? DECLINE_MESSAGES.card_declined;
}

/**
 * How much of an authorized amount actually gets captured. A partial capture is
 * legal for any amount from 1 cent up to the authorization; anything larger is
 * the caller's mistake and is clamped rather than silently over-charging.
 */
export function capturedAmount(authorizedCents: number, requestedCents?: number): number {
  if (requestedCents === undefined || !Number.isInteger(requestedCents)) return authorizedCents;
  return Math.max(1, Math.min(authorizedCents, requestedCents));
}

/**
 * The legal moves. Terminal states are terminal: a FAILED attempt is never
 * revived (the customer retries, which is a NEW attempt), and a DISPUTED one is
 * settled outside this system.
 */
const ALLOWED_TRANSITIONS: Record<AttemptStatus, readonly AttemptStatus[]> = {
  QUEUED: ['REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'DISPUTED', 'CANCELLED'],
  REQUIRES_ACTION: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: ['DISPUTED'],
  FAILED: [],
  DISPUTED: [],
  CANCELLED: [],
};

export function canTransition(from: AttemptStatus, to: AttemptStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Guard a transition, throwing the 409 a route can return verbatim. */
export function assertTransition(from: AttemptStatus, to: AttemptStatus): void {
  if (!canTransition(from, to)) {
    throw new StripePaymentError(
      `Cannot move a ${from} payment to ${to}`,
      409,
      'payment_intent_unexpected_state',
    );
  }
}

/** Our attempt status expressed as the Stripe PaymentIntent status it maps to. */
export function intentStatusFor(status: AttemptStatus): string {
  switch (status) {
    case 'SUCCEEDED':
    case 'DISPUTED':
      return 'succeeded';
    case 'REQUIRES_ACTION':
      return 'requires_action';
    case 'CANCELLED':
      return 'canceled';
    default:
      // FAILED and QUEUED: Stripe parks a failed intent back on
      // requires_payment_method so the customer can supply another card.
      return 'requires_payment_method';
  }
}

/** Wrap an object in Stripe's event envelope. */
export function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  now: Date,
  idempotencyKey?: string | null,
): SandboxEvent {
  return {
    type,
    payload: {
      id: `evt_sbx_${createId()}`,
      object: 'event',
      api_version: API_VERSION,
      created: Math.floor(now.getTime() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: idempotencyKey ?? null },
      type,
      data: { object },
    },
  };
}

interface IntentShape {
  intentId: string;
  orderId: string | null;
  authorizedCents: number;
  capturedCents: number;
  status: AttemptStatus;
  failureCode?: string | null;
  card?: { brand: string; last4: string } | null;
  now: Date;
}

/** A PaymentIntent object with the fields our webhook handler and console read. */
export function intentObject(input: IntentShape): Record<string, unknown> {
  return {
    id: input.intentId,
    object: 'payment_intent',
    amount: input.authorizedCents,
    amount_received: input.status === 'SUCCEEDED' || input.status === 'DISPUTED' ? input.capturedCents : 0,
    amount_capturable: 0,
    currency: CURRENCY,
    status: intentStatusFor(input.status),
    created: Math.floor(input.now.getTime() / 1000),
    livemode: false,
    metadata: { orderId: input.orderId ?? '' },
    latest_charge: chargeIdFor(input.intentId),
    payment_method_details: input.card ? { card: { brand: input.card.brand, last4: input.card.last4 } } : null,
    last_payment_error: input.failureCode
      ? {
          type: 'card_error',
          code: 'card_declined',
          decline_code: input.failureCode,
          message: declineMessage(input.failureCode),
        }
      : null,
  };
}

/** A Charge object — what `charge.refunded` and disputes are built from. */
export function chargeObject(input: {
  intentId: string;
  orderId: string | null;
  capturedCents: number;
  refundedCents: number;
  disputed: boolean;
  card?: { brand: string; last4: string } | null;
  now: Date;
}): Record<string, unknown> {
  return {
    id: chargeIdFor(input.intentId),
    object: 'charge',
    amount: input.capturedCents,
    amount_captured: input.capturedCents,
    amount_refunded: input.refundedCents,
    currency: CURRENCY,
    payment_intent: input.intentId,
    paid: true,
    refunded: input.refundedCents >= input.capturedCents && input.capturedCents > 0,
    disputed: input.disputed,
    status: 'succeeded',
    created: Math.floor(input.now.getTime() / 1000),
    livemode: false,
    metadata: { orderId: input.orderId ?? '' },
    payment_method_details: input.card ? { card: { brand: input.card.brand, last4: input.card.last4 } } : null,
  };
}

/** What the caller receives on a successful (or successfully-replayed) charge. */
export function resultFromAttempt(attempt: SandboxAttempt): StripePaymentResult {
  const meta = attempt.metadata ?? {};
  return {
    paymentId: attempt.intent_id ?? '',
    status: 'succeeded',
    amountCents: meta.capturedCents ?? attempt.amount_cents ?? 0,
    cardBrand: meta.cardBrand ?? TEST_CARDS.succeeded.brand,
    cardLastFour: meta.cardLastFour ?? TEST_CARDS.succeeded.last4,
    cardholderName: CARDHOLDER,
    receiptUrl: attempt.intent_id ? `sandbox://receipts/${attempt.intent_id}` : null,
  };
}

// ===========================================================================
// The state machine — pure
// ===========================================================================

export interface ChargeContext {
  intentId: string;
  orderId: string;
  amountCents: number;
  idempotencyKey: string;
  sourceId?: string | null;
  now: Date;
}

/** How a settlement failed, in the shape the caller's exception needs. */
export interface SettlementError {
  kind: 'decline' | 'challenge' | 'timeout';
  message: string;
  status: number;
  code: string;
}

/**
 * The complete consequence of one charge: where the attempt lands, what webhooks
 * fire, what the caller gets back and/or is thrown at them. Pure, so every branch
 * of the state machine is unit-testable without a database.
 */
export interface Settlement {
  status: AttemptStatus;
  failureCode: string | null;
  metadata: AttemptMetadata;
  events: SandboxEvent[];
  /** Non-null whenever money actually moved — including the TIMEOUT case. */
  result: StripePaymentResult | null;
  error: SettlementError | null;
}

/**
 * Run one scripted outcome against one charge request.
 *
 * The subtle case is TIMEOUT: the attempt lands SUCCEEDED and emits
 * `payment_intent.succeeded` (the processor took the money) while the caller is
 * handed a network error (they never learned). Both `result` and `error` are set;
 * the caller throws now, and the retry that arrives with the same idempotency key
 * gets `result` instead of a second charge.
 *
 * DISPUTED is the mirror image: the charge succeeds normally and the chargeback
 * lands on top of it. Two events, one settlement — the intermediate SUCCEEDED is
 * expressed by `payment_intent.succeeded` preceding `charge.dispute.created`
 * rather than by a row we would immediately overwrite.
 */
export function settleCharge(
  outcome: SandboxOutcome,
  scripted: AttemptMetadata,
  ctx: ChargeContext,
): Settlement {
  const authorized = ctx.amountCents;
  const base: AttemptMetadata = {
    ...scripted,
    sourceId: ctx.sourceId ?? null,
    authorizedCents: authorized,
  };

  switch (outcome) {
    case 'DECLINED': {
      const code = scripted.failureCode ?? pickDeclineCode(ctx.idempotencyKey);
      const card = TEST_CARDS[code] ?? TEST_CARDS.card_declined;
      const metadata: AttemptMetadata = {
        ...base,
        capturedCents: 0,
        cardBrand: card.brand,
        cardLastFour: card.last4,
      };
      return {
        status: 'FAILED',
        failureCode: code,
        metadata,
        events: [
          stripeEvent(
            'payment_intent.payment_failed',
            intentObject({
              intentId: ctx.intentId,
              orderId: ctx.orderId,
              authorizedCents: authorized,
              capturedCents: 0,
              status: 'FAILED',
              failureCode: code,
              card,
              now: ctx.now,
            }),
            ctx.now,
            ctx.idempotencyKey,
          ),
        ],
        result: null,
        error: { kind: 'decline', message: declineMessage(code), status: 402, code },
      };
    }

    case 'REQUIRES_ACTION': {
      const card = TEST_CARDS.requires_action;
      const clientSecret = `${ctx.intentId}_secret_${createId().slice(0, 12)}`;
      const metadata: AttemptMetadata = {
        ...base,
        capturedCents: 0,
        cardBrand: card.brand,
        cardLastFour: card.last4,
        challenge: {
          clientSecret,
          // The Local Console completes the challenge; in cloud mode Stripe.js does.
          returnUrl: `/dev/payments/${ctx.intentId}/challenge`,
        },
      };
      return {
        status: 'REQUIRES_ACTION',
        failureCode: null,
        metadata,
        events: [
          stripeEvent(
            'payment_intent.requires_action',
            intentObject({
              intentId: ctx.intentId,
              orderId: ctx.orderId,
              authorizedCents: authorized,
              capturedCents: 0,
              status: 'REQUIRES_ACTION',
              card,
              now: ctx.now,
            }),
            ctx.now,
            ctx.idempotencyKey,
          ),
        ],
        result: null,
        error: {
          kind: 'challenge',
          message: 'This payment requires additional authentication.',
          status: 402,
          code: 'requires_action',
        },
      };
    }

    case 'TIMEOUT':
    case 'DISPUTED':
    case 'SUCCEEDED': {
      const card = TEST_CARDS.succeeded;
      const captured = capturedAmount(authorized, scripted.captureAmountCents);
      const status: AttemptStatus = outcome === 'DISPUTED' ? 'DISPUTED' : 'SUCCEEDED';
      const metadata: AttemptMetadata = {
        ...base,
        capturedCents: captured,
        refundedCents: 0,
        refunds: [],
        cardBrand: card.brand,
        cardLastFour: card.last4,
        ...(outcome === 'TIMEOUT' ? { timedOut: true } : {}),
      };

      const events: SandboxEvent[] = [
        stripeEvent(
          'payment_intent.succeeded',
          intentObject({
            intentId: ctx.intentId,
            orderId: ctx.orderId,
            authorizedCents: authorized,
            capturedCents: captured,
            status: 'SUCCEEDED',
            card,
            now: ctx.now,
          }),
          ctx.now,
          ctx.idempotencyKey,
        ),
      ];

      if (outcome === 'DISPUTED') {
        const dispute = {
          id: `dp_sbx_${createId()}`,
          reason: 'fraudulent',
          amountCents: captured,
          at: ctx.now.toISOString(),
        };
        metadata.dispute = dispute;
        events.push(
          stripeEvent(
            'charge.dispute.created',
            disputeObject({
              disputeId: dispute.id,
              intentId: ctx.intentId,
              amountCents: captured,
              reason: dispute.reason,
              now: ctx.now,
            }),
            ctx.now,
            ctx.idempotencyKey,
          ),
        );
      }

      const result: StripePaymentResult = {
        paymentId: ctx.intentId,
        status: 'succeeded',
        amountCents: captured,
        cardBrand: card.brand,
        cardLastFour: card.last4,
        cardholderName: CARDHOLDER,
        receiptUrl: `sandbox://receipts/${ctx.intentId}`,
      };

      return {
        status,
        failureCode: null,
        metadata,
        events,
        result,
        error:
          outcome === 'TIMEOUT'
            ? {
                kind: 'timeout',
                message:
                  'The connection to the payment processor timed out. The charge may or may not have completed.',
                status: 502,
                code: 'processing_error',
              }
            : null,
      };
    }
  }
}

/** A Dispute object for `charge.dispute.created`. */
export function disputeObject(input: {
  disputeId: string;
  intentId: string;
  amountCents: number;
  reason: string;
  now: Date;
}): Record<string, unknown> {
  return {
    id: input.disputeId,
    object: 'dispute',
    amount: input.amountCents,
    currency: CURRENCY,
    charge: chargeIdFor(input.intentId),
    payment_intent: input.intentId,
    reason: input.reason,
    status: 'warning_needs_response',
    created: Math.floor(input.now.getTime() / 1000),
    livemode: false,
    is_charge_refundable: false,
  };
}

/** Turn a settlement failure into the exception the routes already understand. */
export function settlementToError(err: SettlementError, ctx: ChargeContext, meta: AttemptMetadata): StripePaymentError {
  if (err.kind === 'challenge' && meta.challenge) {
    return new SandboxChallengeRequired(ctx.intentId, meta.challenge.clientSecret, meta.challenge.returnUrl);
  }
  return new StripePaymentError(err.message, err.status, err.code);
}

/**
 * Decide a refund against an already-settled attempt. Pure — the caller persists
 * the returned metadata and emits the event.
 */
export function settleRefund(
  attempt: SandboxAttempt,
  input: { amountCents: number; reason?: string | null; idempotencyKey: string; now: Date },
): { refund: SandboxRefund; metadata: AttemptMetadata; event: SandboxEvent; replayed: boolean } {
  if (attempt.status === 'DISPUTED') {
    throw new StripePaymentError(
      'This charge is disputed and cannot be refunded — resolve the dispute instead.',
      400,
      'charge_disputed',
    );
  }
  if (attempt.status !== 'SUCCEEDED') {
    throw new StripePaymentError(
      `Cannot refund a payment that is ${attempt.status.toLowerCase()}`,
      400,
      'charge_not_refundable',
    );
  }

  const meta = attempt.metadata ?? {};
  const captured = meta.capturedCents ?? attempt.amount_cents ?? 0;
  const refunds = meta.refunds ?? [];
  const alreadyRefunded = meta.refundedCents ?? 0;

  // Stripe returns the ORIGINAL refund when a key is reused, it does not refund
  // twice. `stripe.ts` derives its key as refund-<intent>-<amount>, so two
  // identical partial refunds collide there too — reproduce that rather than
  // paper over it, because the collision is a real defect worth surfacing.
  const prior = refunds.find((r) => r.idempotencyKey === input.idempotencyKey);
  if (prior) {
    return {
      refund: prior,
      metadata: meta,
      event: refundEvent(attempt, alreadyRefunded, input.now),
      replayed: true,
    };
  }

  const remaining = captured - alreadyRefunded;
  if (remaining <= 0) {
    throw new StripePaymentError('Charge has already been fully refunded', 400, 'charge_already_refunded');
  }
  if (input.amountCents > remaining) {
    throw new StripePaymentError(
      'Refund amount exceeds the refundable balance',
      400,
      'amount_too_large',
    );
  }

  const refund: SandboxRefund = {
    id: `re_sbx_${createId()}`,
    amountCents: input.amountCents,
    reason: input.reason ?? null,
    idempotencyKey: input.idempotencyKey,
    at: input.now.toISOString(),
  };
  const refundedCents = alreadyRefunded + input.amountCents;
  const metadata: AttemptMetadata = { ...meta, refundedCents, refunds: [...refunds, refund] };

  return { refund, metadata, event: refundEvent({ ...attempt, metadata }, refundedCents, input.now), replayed: false };
}

/** `charge.refunded` carries the CUMULATIVE refunded total — what our handler reads. */
function refundEvent(attempt: SandboxAttempt, refundedCents: number, now: Date): SandboxEvent {
  const meta = attempt.metadata ?? {};
  return stripeEvent(
    'charge.refunded',
    chargeObject({
      intentId: attempt.intent_id ?? '',
      orderId: attempt.order_id,
      capturedCents: meta.capturedCents ?? attempt.amount_cents ?? 0,
      refundedCents,
      disputed: false,
      card: meta.cardBrand && meta.cardLastFour ? { brand: meta.cardBrand, last4: meta.cardLastFour } : null,
      now,
    }),
    now,
  );
}

// ===========================================================================
// Store seam — lets the engine be driven by Prisma in production and by an
// in-memory fake in the unit tests, without the engine knowing which.
// ===========================================================================

/** The store owns the tenant, so `operator_id` is not the engine's to supply. */
export type NewAttempt = Omit<SandboxAttempt, 'id' | 'created_at' | 'operator_id'>;
export type AttemptPatch = Partial<Omit<SandboxAttempt, 'id' | 'operator_id' | 'created_at'>>;

export interface SandboxStore {
  findByIdempotencyKey(key: string): Promise<SandboxAttempt | null>;
  findByIntent(intentId: string): Promise<SandboxAttempt | null>;
  /** Oldest instruction still waiting to be consumed, or null. */
  nextQueued(): Promise<SandboxAttempt | null>;
  /** Claim a QUEUED row; null when another charge got there first. */
  claimQueued(id: string, patch: AttemptPatch): Promise<SandboxAttempt | null>;
  /** Throws SandboxDuplicateKeyError if the idempotency key is taken. */
  create(data: NewAttempt): Promise<SandboxAttempt>;
  update(id: string, patch: AttemptPatch): Promise<SandboxAttempt>;
  emit(attemptId: string, events: SandboxEvent[]): Promise<void>;
}

/**
 * How many queued rows to try before giving up and using the default. Only ever
 * exceeded when several charges race for the same instruction; bounded so a
 * pathological queue cannot spin.
 */
const MAX_QUEUE_CLAIM_ATTEMPTS = 8;

// ===========================================================================
// Engine — store-driven, no Prisma
// ===========================================================================

/**
 * Replay a charge that this idempotency key already produced.
 *
 * Stripe's contract: the same key returns the ORIGINAL response — a success
 * replays as a success, a decline replays as the same decline. Reusing a key with
 * different parameters is an error, which is what stops a key collision from
 * silently under-charging someone.
 */
function replayAttempt(attempt: SandboxAttempt, ctx: ChargeContext): StripePaymentResult {
  const sameAmount = attempt.amount_cents === null || attempt.amount_cents === ctx.amountCents;
  const sameOrder = attempt.order_id === null || attempt.order_id === ctx.orderId;
  if (!sameAmount || !sameOrder) {
    throw new StripePaymentError(
      'Keys for idempotent requests can only be used with the same parameters they were first used with.',
      400,
      'idempotency_error',
    );
  }

  switch (attempt.status) {
    case 'SUCCEEDED':
    case 'DISPUTED':
      // Includes the TIMEOUT case: the first call threw, the money moved, and
      // this retry is how the caller finally learns the charge went through.
      return resultFromAttempt(attempt);
    case 'FAILED': {
      const code = attempt.failure_code ?? 'card_declined';
      throw new StripePaymentError(declineMessage(code), 402, code);
    }
    case 'REQUIRES_ACTION': {
      const challenge = attempt.metadata?.challenge;
      throw new SandboxChallengeRequired(
        attempt.intent_id ?? ctx.intentId,
        challenge?.clientSecret ?? '',
        challenge?.returnUrl ?? '',
      );
    }
    default:
      throw new StripePaymentError(
        'This idempotency key belongs to a payment that never completed.',
        409,
        'idempotency_error',
      );
  }
}

/** Consume the next scripted outcome, defaulting to SUCCEEDED when none is queued. */
async function consumeOutcome(
  store: SandboxStore,
  ctx: ChargeContext,
): Promise<{ attempt: SandboxAttempt; settlement: Settlement } | null> {
  for (let i = 0; i < MAX_QUEUE_CLAIM_ATTEMPTS; i += 1) {
    const queued = await store.nextQueued();
    if (!queued) return null;

    const settlement = settleCharge(queued.outcome, queued.metadata ?? {}, ctx);
    const claimed = await store.claimQueued(queued.id, {
      intent_id: ctx.intentId,
      amount_cents: ctx.amountCents,
      status: settlement.status,
      order_id: ctx.orderId,
      failure_code: settlement.failureCode,
      idempotency_key: ctx.idempotencyKey,
      metadata: settlement.metadata,
      consumed_at: ctx.now,
    });
    if (claimed) return { attempt: claimed, settlement };
    // Another concurrent charge took it — try the one behind it.
  }
  return null;
}

/**
 * Charge, against an arbitrary store. This is the whole simulator; everything
 * below it is Prisma plumbing.
 */
export async function chargeWithStore(store: SandboxStore, ctx: ChargeContext): Promise<StripePaymentResult> {
  if (!Number.isInteger(ctx.amountCents) || ctx.amountCents <= 0) {
    throw new StripePaymentError('Charge amount must be a positive integer (cents)', 400);
  }

  const existing = await store.findByIdempotencyKey(ctx.idempotencyKey);
  if (existing) return replayAttempt(existing, ctx);

  const consumed = await consumeOutcome(store, ctx);

  let attempt: SandboxAttempt;
  let settlement: Settlement;
  if (consumed) {
    ({ attempt, settlement } = consumed);
  } else {
    settlement = settleCharge('SUCCEEDED', {}, ctx);
    try {
      attempt = await store.create({
        intent_id: ctx.intentId,
        amount_cents: ctx.amountCents,
        outcome: 'SUCCEEDED',
        status: settlement.status,
        order_id: ctx.orderId,
        failure_code: settlement.failureCode,
        idempotency_key: ctx.idempotencyKey,
        metadata: settlement.metadata,
        consumed_at: ctx.now,
      });
    } catch (err) {
      if (!(err instanceof SandboxDuplicateKeyError)) throw err;
      // Lost the unique-index race to a concurrent request with the same key.
      // The durable guard did its job; read back the winner and replay it.
      const winner = await store.findByIdempotencyKey(ctx.idempotencyKey);
      if (!winner) throw err;
      return replayAttempt(winner, ctx);
    }
  }

  await store.emit(attempt.id, settlement.events);

  if (settlement.error) {
    throw settlementToError(settlement.error, ctx, settlement.metadata);
  }
  // settleCharge always pairs a null error with a result.
  return settlement.result!;
}

/** Complete (or fail) an outstanding 3DS challenge. */
export async function confirmWithStore(
  store: SandboxStore,
  input: { intentId: string; succeed: boolean; now: Date },
): Promise<StripePaymentResult> {
  const attempt = await store.findByIntent(input.intentId);
  if (!attempt) {
    throw new StripePaymentError(`No such payment_intent: ${input.intentId}`, 404, 'resource_missing');
  }
  assertTransition(attempt.status, input.succeed ? 'SUCCEEDED' : 'FAILED');

  const meta = attempt.metadata ?? {};
  const authorized = attempt.amount_cents ?? 0;
  const card = TEST_CARDS.requires_action;

  if (!input.succeed) {
    const code = 'payment_intent_authentication_failure';
    const metadata: AttemptMetadata = {
      ...meta,
      capturedCents: 0,
      challenge: meta.challenge
        ? { ...meta.challenge, resolvedAt: input.now.toISOString(), succeeded: false }
        : undefined,
    };
    await store.update(attempt.id, { status: 'FAILED', failure_code: code, metadata });
    await store.emit(attempt.id, [
      stripeEvent(
        'payment_intent.payment_failed',
        intentObject({
          intentId: input.intentId,
          orderId: attempt.order_id,
          authorizedCents: authorized,
          capturedCents: 0,
          status: 'FAILED',
          failureCode: code,
          card,
          now: input.now,
        }),
        input.now,
        attempt.idempotency_key,
      ),
    ]);
    throw new StripePaymentError(
      'We are unable to authenticate your payment method. Please choose a different payment method and try again.',
      402,
      code,
    );
  }

  const captured = capturedAmount(authorized, meta.captureAmountCents);
  const successCard = TEST_CARDS.succeeded;
  const metadata: AttemptMetadata = {
    ...meta,
    capturedCents: captured,
    refundedCents: 0,
    refunds: [],
    cardBrand: successCard.brand,
    cardLastFour: successCard.last4,
    challenge: meta.challenge
      ? { ...meta.challenge, resolvedAt: input.now.toISOString(), succeeded: true }
      : undefined,
  };
  const updated = await store.update(attempt.id, {
    status: 'SUCCEEDED',
    failure_code: null,
    metadata,
  });
  await store.emit(attempt.id, [
    stripeEvent(
      'payment_intent.succeeded',
      intentObject({
        intentId: input.intentId,
        orderId: attempt.order_id,
        authorizedCents: authorized,
        capturedCents: captured,
        status: 'SUCCEEDED',
        card: successCard,
        now: input.now,
      }),
      input.now,
      attempt.idempotency_key,
    ),
  ]);
  return resultFromAttempt(updated);
}

/** Refund a settled attempt, fully or partially. */
export async function refundWithStore(
  store: SandboxStore,
  input: { intentId: string; amountCents: number; reason?: string | null; idempotencyKey?: string; now: Date },
): Promise<StripeRefundResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new StripePaymentError('Refund amount must be a positive integer (cents)', 400);
  }
  const attempt = await store.findByIntent(input.intentId);
  if (!attempt) {
    throw new StripePaymentError(`No such payment_intent: ${input.intentId}`, 404, 'resource_missing');
  }

  const key = input.idempotencyKey ?? `refund-${input.intentId}-${input.amountCents}`;
  const settled = settleRefund(attempt, {
    amountCents: input.amountCents,
    reason: input.reason ?? null,
    idempotencyKey: key,
    now: input.now,
  });

  if (!settled.replayed) {
    await store.update(attempt.id, { metadata: settled.metadata });
    await store.emit(attempt.id, [settled.event]);
  }

  return {
    refundId: settled.refund.id,
    status: 'succeeded',
    amountCents: settled.refund.amountCents,
  };
}

/** Land a chargeback on a previously successful attempt. */
export async function disputeWithStore(
  store: SandboxStore,
  input: { intentId: string; reason?: string; amountCents?: number; now: Date },
): Promise<{ disputeId: string; amountCents: number; reason: string }> {
  const attempt = await store.findByIntent(input.intentId);
  if (!attempt) {
    throw new StripePaymentError(`No such payment_intent: ${input.intentId}`, 404, 'resource_missing');
  }
  assertTransition(attempt.status, 'DISPUTED');

  const meta = attempt.metadata ?? {};
  const captured = meta.capturedCents ?? attempt.amount_cents ?? 0;
  const amountCents = input.amountCents ?? captured;
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > captured) {
    throw new StripePaymentError('Dispute amount must be between 1 cent and the captured amount', 400);
  }
  const reason = input.reason ?? 'fraudulent';
  const dispute = { id: `dp_sbx_${createId()}`, reason, amountCents, at: input.now.toISOString() };

  await store.update(attempt.id, { status: 'DISPUTED', metadata: { ...meta, dispute } });
  await store.emit(attempt.id, [
    stripeEvent(
      'charge.dispute.created',
      disputeObject({
        disputeId: dispute.id,
        intentId: input.intentId,
        amountCents,
        reason,
        now: input.now,
      }),
      input.now,
      attempt.idempotency_key,
    ),
  ]);
  return { disputeId: dispute.id, amountCents, reason };
}

// ===========================================================================
// Prisma-backed store
// ===========================================================================

/** Prisma's Json input rejects `undefined` members; a round-trip strips them. */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

/** Postgres unique-violation, surfaced by Prisma as P2002. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

type AttemptRow = {
  id: string;
  operator_id: string;
  intent_id: string | null;
  amount_cents: number | null;
  outcome: string;
  status: string;
  order_id: string | null;
  failure_code: string | null;
  idempotency_key: string | null;
  metadata: unknown;
  consumed_at: Date | null;
  created_at: Date;
};

function toAttempt(row: AttemptRow): SandboxAttempt {
  return {
    id: row.id,
    operator_id: row.operator_id,
    intent_id: row.intent_id,
    amount_cents: row.amount_cents,
    outcome: row.outcome as SandboxOutcome,
    status: row.status as AttemptStatus,
    order_id: row.order_id,
    failure_code: row.failure_code,
    idempotency_key: row.idempotency_key,
    metadata: (row.metadata as AttemptMetadata | null) ?? null,
    consumed_at: row.consumed_at,
    created_at: row.created_at,
  };
}

/** Translate an AttemptPatch into Prisma update data. */
function patchData(patch: AttemptPatch): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (patch.intent_id !== undefined) data.intent_id = patch.intent_id;
  if (patch.amount_cents !== undefined) data.amount_cents = patch.amount_cents;
  if (patch.outcome !== undefined) data.outcome = patch.outcome;
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.order_id !== undefined) data.order_id = patch.order_id;
  if (patch.failure_code !== undefined) data.failure_code = patch.failure_code;
  if (patch.idempotency_key !== undefined) data.idempotency_key = patch.idempotency_key;
  if (patch.metadata !== undefined) data.metadata = toJson(patch.metadata);
  if (patch.consumed_at !== undefined) data.consumed_at = patch.consumed_at;
  return data;
}

/**
 * The production store. Every read and write goes through the tenant-scoped
 * client, so RLS still applies — the simulator is as multi-tenant as the rest of
 * the platform, and one operator can never pop another's queued outcome.
 */
export function prismaStore(db: TenantClient, operatorId: string): SandboxStore {
  const attempts = db.sandboxPaymentAttempt;
  return {
    async findByIdempotencyKey(key) {
      const row = await attempts.findFirst({ where: { idempotency_key: key } });
      return row ? toAttempt(row as AttemptRow) : null;
    },
    async findByIntent(intentId) {
      const row = await attempts.findFirst({ where: { intent_id: intentId } });
      return row ? toAttempt(row as AttemptRow) : null;
    },
    async nextQueued() {
      const row = await attempts.findFirst({
        where: { status: 'QUEUED' },
        orderBy: { created_at: 'asc' },
      });
      return row ? toAttempt(row as AttemptRow) : null;
    },
    async claimQueued(id, patch) {
      // Conditional update: whoever flips it off QUEUED first owns it. A plain
      // read-then-write would let two concurrent charges consume one instruction.
      const claimed = await attempts.updateMany({
        where: { id, status: 'QUEUED' },
        data: patchData(patch),
      });
      if (claimed.count === 0) return null;
      const row = await attempts.findUnique({ where: { id } });
      return row ? toAttempt(row as AttemptRow) : null;
    },
    async create(data) {
      try {
        const row = await attempts.create({
          data: {
            id: createId(),
            // Top-level create: operator_id must be explicit (D-011).
            operator_id: operatorId,
            intent_id: data.intent_id,
            amount_cents: data.amount_cents,
            outcome: data.outcome,
            status: data.status,
            order_id: data.order_id,
            failure_code: data.failure_code,
            idempotency_key: data.idempotency_key,
            metadata: toJson(data.metadata),
            consumed_at: data.consumed_at,
          },
        });
        return toAttempt(row as AttemptRow);
      } catch (err) {
        if (isUniqueViolation(err)) throw new SandboxDuplicateKeyError();
        throw err;
      }
    },
    async update(id, patch) {
      const row = await attempts.update({ where: { id }, data: patchData(patch) });
      return toAttempt(row as AttemptRow);
    },
    async emit(attemptId, events) {
      for (const event of events) {
        await db.sandboxWebhook.create({
          data: {
            id: createId(),
            operator_id: operatorId,
            event_type: event.type,
            payload: toJson(event.payload),
            status: 'PENDING',
            attempt_id: attemptId,
          },
        });
      }
    },
  };
}

// ===========================================================================
// Clock
// ===========================================================================

/** The operator's sandbox clock offset in seconds (0 when no row exists). */
export async function getClockOffset(db: TenantClient, operatorId: string): Promise<number> {
  const row = await db.sandboxClock.findUnique({ where: { operator_id: operatorId } });
  return row?.offset_seconds ?? 0;
}

/** Set the offset outright. Negative values are legal — the past is testable too. */
export async function setClockOffset(
  db: TenantClient,
  operatorId: string,
  offsetSeconds: number,
): Promise<number> {
  const row = await db.sandboxClock.upsert({
    where: { operator_id: operatorId },
    create: { id: createId(), operator_id: operatorId, offset_seconds: offsetSeconds },
    update: { offset_seconds: offsetSeconds },
  });
  return row.offset_seconds;
}

/** "Now" as this operator's sandbox sees it. */
export async function sandboxNow(db: TenantClient, operatorId: string): Promise<Date> {
  const offset = await getClockOffset(db, operatorId);
  return new Date(Date.now() + offset * 1000);
}

// ===========================================================================
// Console operations — queue, listing, webhook delivery and replay
// ===========================================================================

export interface QueueOutcomeInput {
  outcome: SandboxOutcome;
  failureCode?: DeclineCode;
  captureAmountCents?: number;
  note?: string;
}

/**
 * Script the NEXT outcome. Written as a QUEUED attempt with no intent id and no
 * amount — those arrive when a charge pops it. Deliberately allows several to be
 * stacked: queue DECLINED then SUCCEEDED and you have a retry scenario ready.
 */
export async function queueOutcome(
  db: TenantClient,
  operatorId: string,
  input: QueueOutcomeInput,
): Promise<SandboxAttempt> {
  const metadata: AttemptMetadata = {};
  if (input.failureCode) metadata.failureCode = input.failureCode;
  if (input.captureAmountCents !== undefined) metadata.captureAmountCents = input.captureAmountCents;
  if (input.note) metadata.note = input.note;

  const row = await db.sandboxPaymentAttempt.create({
    data: {
      id: createId(),
      operator_id: operatorId,
      outcome: input.outcome,
      status: 'QUEUED',
      metadata: toJson(metadata),
    },
  });
  return toAttempt(row as AttemptRow);
}

/** Drop every un-consumed instruction. CANCELLED, not deleted — the console keeps history. */
export async function clearQueue(db: TenantClient): Promise<number> {
  const result = await db.sandboxPaymentAttempt.updateMany({
    where: { status: 'QUEUED' },
    data: { status: 'CANCELLED' },
  });
  return result.count;
}

/** Instructions still waiting, oldest first — "next outcome: DECLINED". */
export async function listQueued(db: TenantClient): Promise<SandboxAttempt[]> {
  const rows = await db.sandboxPaymentAttempt.findMany({
    where: { status: 'QUEUED' },
    orderBy: { created_at: 'asc' },
  });
  return (rows as AttemptRow[]).map(toAttempt);
}

/** Attempt history, newest first. */
export async function listAttempts(
  db: TenantClient,
  opts: { limit?: number; status?: AttemptStatus } = {},
): Promise<SandboxAttempt[]> {
  const rows = await db.sandboxPaymentAttempt.findMany({
    where: opts.status ? { status: opts.status } : undefined,
    orderBy: { created_at: 'desc' },
    take: Math.min(200, Math.max(1, opts.limit ?? 50)),
  });
  return (rows as AttemptRow[]).map(toAttempt);
}

export interface SandboxWebhookRow {
  id: string;
  event_type: string;
  payload: unknown;
  status: string;
  delivered_at: Date | null;
  error: string | null;
  attempt_id: string | null;
  replay_of_id: string | null;
  created_at: Date;
}

export async function listWebhooks(
  db: TenantClient,
  opts: { limit?: number; eventType?: string } = {},
): Promise<SandboxWebhookRow[]> {
  return (await db.sandboxWebhook.findMany({
    where: opts.eventType ? { event_type: opts.eventType } : undefined,
    orderBy: { created_at: 'desc' },
    take: Math.min(200, Math.max(1, opts.limit ?? 50)),
  })) as SandboxWebhookRow[];
}

/**
 * Where a simulated webhook is POSTed. Defaults to this API's own Stripe webhook
 * route, which is the point: the handler under test is the production handler.
 */
function webhookEndpoint(): string {
  return (
    process.env.SANDBOX_WEBHOOK_URL ??
    `http://127.0.0.1:${process.env.PORT ?? 3001}/webhooks/stripe`
  );
}

/**
 * Delivery transport, swappable so a test can dispatch in-process instead of over
 * the loopback. Returns nothing on success and throws to signal a failed delivery.
 */
export type WebhookDelivery = (event: { type: string; payload: unknown }) => Promise<void>;

let deliveryTransport: WebhookDelivery | null = null;

export function setSandboxWebhookDelivery(fn: WebhookDelivery | null): void {
  deliveryTransport = fn;
}

async function postWebhook(event: { type: string; payload: unknown }): Promise<void> {
  if (deliveryTransport) return deliveryTransport(event);
  const res = await fetch(webhookEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event.payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`endpoint returned ${res.status}`);
  }
}

/**
 * Attempt delivery of one stored webhook and record the result.
 *
 * Emission and delivery are deliberately SEPARATE steps. The payments route
 * writes its Payment row *after* the provider returns, so a `payment_intent.
 * succeeded` delivered inline would arrive before the row exists and no-op.
 * Draining afterwards is both deterministic and closer to Stripe, whose events
 * arrive out of band and at least once.
 */
export async function deliverWebhook(
  db: TenantClient,
  row: { id: string; event_type: string; payload: unknown },
  now: Date,
): Promise<{ delivered: boolean; error: string | null }> {
  try {
    await postWebhook({ type: row.event_type, payload: row.payload });
    await db.sandboxWebhook.update({
      where: { id: row.id },
      data: { status: 'DELIVERED', delivered_at: now, error: null },
    });
    return { delivered: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.sandboxWebhook.update({
      where: { id: row.id },
      data: { status: 'FAILED', error: message.slice(0, 500) },
    });
    return { delivered: false, error: message };
  }
}

/** Deliver everything still PENDING, oldest first. */
export async function deliverPending(
  db: TenantClient,
  operatorId: string,
  limit = 50,
): Promise<{ delivered: number; failed: number }> {
  const now = await sandboxNow(db, operatorId);
  const rows = (await db.sandboxWebhook.findMany({
    where: { status: 'PENDING' },
    orderBy: { created_at: 'asc' },
    take: Math.min(200, Math.max(1, limit)),
  })) as SandboxWebhookRow[];

  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await deliverWebhook(db, row, now);
    if (result.delivered) delivered += 1;
    else failed += 1;
  }
  return { delivered, failed };
}

/**
 * Replay a webhook. A replay is a NEW row pointing at the original, and it re-uses
 * the original payload verbatim — same Stripe event id and all — because the thing
 * worth testing is whether the handler is idempotent under a redelivery.
 */
export async function replayWebhook(
  db: TenantClient,
  operatorId: string,
  webhookId: string,
): Promise<{ id: string; delivered: boolean; error: string | null } | null> {
  const original = (await db.sandboxWebhook.findUnique({ where: { id: webhookId } })) as SandboxWebhookRow | null;
  if (!original) return null;

  const replay = (await db.sandboxWebhook.create({
    data: {
      id: createId(),
      operator_id: operatorId,
      event_type: original.event_type,
      payload: toJson(original.payload),
      status: 'PENDING',
      attempt_id: original.attempt_id,
      // Chain to the ORIGINAL, not to another replay, so history stays a fan-out.
      replay_of_id: original.replay_of_id ?? original.id,
    },
  })) as SandboxWebhookRow;

  const now = await sandboxNow(db, operatorId);
  const result = await deliverWebhook(db, replay, now);
  return { id: replay.id, delivered: result.delivered, error: result.error };
}

// ===========================================================================
// Public driver surface — signature-compatible with ./stripe.ts
// ===========================================================================

/**
 * Resolve the tenant for a charge when the caller did not pass one.
 *
 * `stripe.ts`'s `createPayment` takes no operator id because Stripe does not need
 * one. To stay a drop-in replacement the sandbox accepts the same input and, when
 * `operatorId` is absent, looks the order up cross-tenant with the admin client —
 * the same deliberate exception `routes/webhooks.ts` already makes. Passing
 * `operatorId` explicitly (one line in `routes/payments.ts`) skips this query.
 */
async function operatorForOrder(orderId: string): Promise<string> {
  const order = await adminPrisma.order.findUnique({
    where: { id: orderId },
    select: { operator_id: true },
  });
  if (!order) throw new StripePaymentError(`No such order: ${orderId}`, 404, 'resource_missing');
  return order.operator_id;
}

async function operatorForIntent(intentId: string): Promise<string> {
  const attempt = await adminPrisma.sandboxPaymentAttempt.findFirst({
    where: { intent_id: intentId },
    select: { operator_id: true },
  });
  if (!attempt) {
    throw new StripePaymentError(`No such payment_intent: ${intentId}`, 404, 'resource_missing');
  }
  return attempt.operator_id;
}

/** Charge a card. Same signature as `stripe.ts`, plus an optional tenant hint. */
export async function createPayment(input: {
  orderId: string;
  sourceId: string;
  amountCents: number;
  idempotencyKey: string;
  operatorId?: string;
}): Promise<StripePaymentResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new StripePaymentError('Charge amount must be a positive integer (cents)', 400);
  }
  const operatorId = input.operatorId ?? (await operatorForOrder(input.orderId));
  const db = forOperator(operatorId);
  const now = await sandboxNow(db, operatorId);

  return chargeWithStore(prismaStore(db, operatorId), {
    intentId: newIntentId(),
    orderId: input.orderId,
    amountCents: input.amountCents,
    idempotencyKey: input.idempotencyKey,
    sourceId: input.sourceId,
    now,
  });
}

/** Refund a simulated charge. Same signature as `stripe.ts`. */
export async function refundPayment(input: {
  paymentId: string;
  amountCents: number;
  reason?: string;
  operatorId?: string;
}): Promise<StripeRefundResult> {
  const operatorId = input.operatorId ?? (await operatorForIntent(input.paymentId));
  const db = forOperator(operatorId);
  const now = await sandboxNow(db, operatorId);

  return refundWithStore(prismaStore(db, operatorId), {
    intentId: input.paymentId,
    amountCents: input.amountCents,
    reason: input.reason ?? null,
    now,
  });
}

/** Complete or fail an outstanding 3DS challenge (driven by the Local Console). */
export async function confirmChallenge(input: {
  operatorId: string;
  intentId: string;
  succeed: boolean;
}): Promise<StripePaymentResult> {
  const db = forOperator(input.operatorId);
  const now = await sandboxNow(db, input.operatorId);
  return confirmWithStore(prismaStore(db, input.operatorId), {
    intentId: input.intentId,
    succeed: input.succeed,
    now,
  });
}

/** Land a chargeback on a past successful attempt. */
export async function disputePayment(input: {
  operatorId: string;
  intentId: string;
  reason?: string;
  amountCents?: number;
}): Promise<{ disputeId: string; amountCents: number; reason: string }> {
  const db = forOperator(input.operatorId);
  const now = await sandboxNow(db, input.operatorId);
  return disputeWithStore(prismaStore(db, input.operatorId), {
    intentId: input.intentId,
    reason: input.reason,
    amountCents: input.amountCents,
    now,
  });
}
