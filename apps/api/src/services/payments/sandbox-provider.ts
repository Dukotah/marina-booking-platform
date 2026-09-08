/**
 * Sandbox implementation of the PaymentProvider seam — the no-account driver.
 *
 * Wraps the two pre-existing fake payment paths behind the interface:
 *
 *   1. THE SIMULATOR (`../payments-sandbox.ts`, active when `sandboxEnabled()`):
 *      a faithful reproduction of the PaymentIntent state machine — scripted
 *      declines, 3DS challenges, timeouts, partial capture/refund, disputes, and
 *      Stripe-shaped webhook emission. This is what runs in every local/dev/test
 *      environment by default (docs/LOCAL-FIRST-BUILD.md §0: the owner can exercise
 *      100% of the product with no Stripe account).
 *   2. THE CRUDE FAKE (DEV_FAKE_PAYMENTS=true with the simulator off, e.g.
 *      SANDBOX=cloud in dev): every charge succeeds instantly with a fixed test
 *      card. Kept verbatim from the pre-seam `stripe.ts` driver.
 *
 * The simulator signals expected outcomes by THROWING (its historical contract
 * with the routes); this adapter translates those throws into the seam's
 * ChargeOutcome values so callers of the interface never see driver-specific
 * exception types.
 */
import { forOperator } from '@marina/database';
import { StripePaymentError } from '../stripe.js';
import {
  confirmChallenge as sandboxConfirmChallenge,
  createPayment as sandboxCreatePayment,
  refundPayment as sandboxRefundPayment,
  sandboxPaymentsEnabled,
  SandboxChallengeRequired,
} from '../payments-sandbox.js';
import type { StripePaymentResult } from '../stripe.js';
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

/** Map the simulator's result shape onto the seam's settled-charge shape. */
function settled(result: StripePaymentResult): SettledChargeResult {
  return {
    paymentRef: result.paymentId,
    amountCents: result.amountCents,
    cardBrand: result.cardBrand,
    cardLastFour: result.cardLastFour,
    cardholderName: result.cardholderName,
    receiptUrl: result.receiptUrl,
  };
}

/**
 * The simulator emits Stripe-shaped events; normalize them structurally (no SDK
 * types — those stay confined to stripe-provider.ts).
 */
function normalizeParsedEvent(event: {
  type?: unknown;
  data?: { object?: Record<string, unknown> };
}): NormalizedPaymentEvent[] {
  const object = event.data?.object ?? {};
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const id = typeof object.id === 'string' ? object.id : null;
      return id ? [{ type: 'payment_succeeded', paymentRef: id }] : [];
    }
    case 'payment_intent.payment_failed': {
      const id = typeof object.id === 'string' ? object.id : null;
      return id ? [{ type: 'payment_failed', paymentRef: id }] : [];
    }
    case 'charge.refunded': {
      const paymentRef =
        typeof object.payment_intent === 'string' ? object.payment_intent : null;
      if (!paymentRef) return [];
      const refunded = typeof object.amount_refunded === 'number' ? object.amount_refunded : 0;
      return [{ type: 'refund_completed', paymentRef, refundedTotalCents: refunded }];
    }
    default:
      return [];
  }
}

export const sandboxProvider: PaymentProvider = {
  providerKey: 'sandbox',

  isConfigured: () => true, // resolved only when a fake mode is active

  clientConfig(): ClientPaymentConfig {
    return { kind: 'sandbox' };
  },

  async charge(input: ProviderChargeInput): Promise<ChargeOutcome> {
    // Crude fake (simulator off): succeed without touching anything external.
    if (!sandboxPaymentsEnabled()) {
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
      return {
        status: 'succeeded',
        paymentRef: `dev_pi_${input.idempotencyKey}`,
        amountCents: input.amountCents,
        cardBrand: 'Visa',
        cardLastFour: '4242',
        cardholderName: 'Dev Tester',
        receiptUrl: null,
      };
    }

    try {
      const result = await sandboxCreatePayment({
        orderId: input.orderId,
        sourceId: input.tokenizedSource,
        amountCents: input.amountCents,
        idempotencyKey: input.idempotencyKey,
        operatorId: input.operatorId,
      });
      return { status: 'succeeded', ...settled(result) };
    } catch (err) {
      if (err instanceof SandboxChallengeRequired) {
        return {
          status: 'requires_action',
          amountCents: input.amountCents,
          challenge: {
            intentId: err.intentId,
            clientSecret: err.clientSecret,
            returnUrl: err.challengeUrl,
          },
        };
      }
      if (err instanceof StripePaymentError) {
        return {
          status: 'failed',
          failure: { message: err.message, code: err.code ?? null, httpStatus: err.status },
        };
      }
      throw err;
    }
  },

  async confirmChallenge({ intentId, action, operatorId }): Promise<SettledChargeResult | null> {
    if (!sandboxPaymentsEnabled()) {
      // The crude fake never issues a challenge, so there is nothing to confirm.
      throw new StripePaymentError(`No such payment_intent: ${intentId}`, 404, 'resource_missing');
    }

    if (action === 'cancel') {
      // The simulator signals a failed authentication by THROWING after it has
      // recorded the attempt as FAILED — that is its contract, so the one expected
      // error is swallowed and anything else (a missing intent, an illegal
      // transition) still surfaces.
      try {
        await sandboxConfirmChallenge({ operatorId, intentId, succeed: false });
      } catch (err) {
        const expected =
          err instanceof StripePaymentError && err.code === 'payment_intent_authentication_failure';
        if (!expected) throw err;
      }
      return null;
    }

    return settled(await sandboxConfirmChallenge({ operatorId, intentId, succeed: true }));
  },

  /**
   * The simulator keeps its own attempt ledger, which is exactly the lookup Stripe
   * would answer from its side — so a /confirm call that lost the intent id can
   * still find the outstanding challenge for its order. Tenant-scoped (RLS).
   */
  async pendingChallenge({ orderId, operatorId }): Promise<string | null> {
    if (!sandboxPaymentsEnabled()) return null;
    const db = forOperator(operatorId);
    const attempt = await db.sandboxPaymentAttempt.findFirst({
      where: { order_id: orderId, status: 'REQUIRES_ACTION' },
      orderBy: { created_at: 'desc' },
      select: { intent_id: true },
    });
    return attempt?.intent_id ?? null;
  },

  async refund(input: ProviderRefundInput): Promise<RefundOutcome> {
    if (!sandboxPaymentsEnabled()) {
      if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
        throw new StripePaymentError('Refund amount must be a positive integer (cents)', 400);
      }
      return {
        refundRef: `dev_re_${input.paymentRef}_${input.amountCents}`,
        status: 'succeeded',
        amountCents: input.amountCents,
      };
    }
    const result = await sandboxRefundPayment({
      paymentId: input.paymentRef,
      amountCents: input.amountCents,
      reason: input.reason,
      operatorId: input.operatorId,
    });
    return { refundRef: result.refundId, status: result.status, amountCents: result.amountCents };
  },

  /**
   * Local trust: the simulator delivers its own Stripe-shaped events over the
   * loopback with no signature (services/payments-sandbox.ts `deliverWebhook`), so
   * they are parsed unverified — exactly what dev-mode Stripe (no webhook secret)
   * does. A malformed body throws (SyntaxError) and the route answers 400.
   */
  verifyAndParseWebhook(rawBody): ParsedWebhook {
    const event = JSON.parse(rawBody) as {
      id?: unknown;
      type?: unknown;
      data?: { object?: Record<string, unknown> };
    };
    return {
      providerEventId: typeof event.id === 'string' ? event.id : null,
      providerEventType: typeof event.type === 'string' ? event.type : null,
      events: normalizeParsedEvent(event),
    };
  },
};
