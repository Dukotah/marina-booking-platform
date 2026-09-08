/**
 * Stripe implementation of the PaymentProvider seam (PaymentIntents).
 *
 * The ONLY file (with `../stripe.ts`) where Stripe SDK types may appear; nothing
 * Stripe-shaped leaks past the interface in `./types.ts`. It deliberately does NOT
 * touch the database — the routes own the Payment/Order/OrderEvent writes so they
 * stay inside one tenant-scoped transaction. This module only talks to Stripe and
 * normalizes its results and errors into the seam's plain shapes.
 *
 * Keys come from the resolver (`./index.ts`): either the process env
 * (STRIPE_SECRET_KEY et al.) or a per-operator `stripe` Integration record.
 *
 * Charge model: the browser collects a card with Stripe.js / Elements and creates
 * a PaymentMethod, whose id arrives as `tokenizedSource`. We create + confirm a
 * PaymentIntent with that payment method in one synchronous call.
 *
 * 3-D SECURE FIX: the pre-seam driver discarded the PaymentIntent whenever the
 * status was not `succeeded`, so a `requires_action` intent came back as a bare
 * decline with no intent id / client secret — the browser had nothing to hand
 * Stripe.js and the challenge could never be completed with real Stripe (the
 * sandbox driver carried its intent data through; this one dropped it). The
 * interface's `requires_action` outcome now preserves `intent.id` +
 * `intent.client_secret`, so POST /charge answers a complete challenge affordance
 * for BOTH drivers.
 */
import type Stripe from 'stripe';
import { getStripeClient, toPaymentError, StripePaymentError } from '../stripe.js';
import type {
  ChargeOutcome,
  ClientPaymentConfig,
  ParsedWebhook,
  PaymentProvider,
  ProviderChargeInput,
  ProviderRefundInput,
  RefundOutcome,
  SettledChargeResult,
  NormalizedPaymentEvent,
} from './types.js';

/** USD is the only supported settlement currency for now. */
const CURRENCY = 'usd';

/** The key material one Stripe provider instance runs on. */
export interface StripeProviderConfig {
  secretKey: string;
  /** Safe for the browser; absent = cards cannot be collected client-side. */
  publishableKey: string | null;
  /** Enables webhook signature verification when present. */
  webhookSecret: string | null;
}

/** Read the platform-wide Stripe configuration from the process env. */
export function envStripeConfig(): StripeProviderConfig | null {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return null;
  return {
    secretKey,
    publishableKey:
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim() ||
      process.env.STRIPE_PUBLISHABLE_KEY?.trim() ||
      null,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() || null,
  };
}

/** Pull the settled-charge fields off a succeeded/retrieved intent. */
function settledFromIntent(intent: Stripe.PaymentIntent, fallbackCents: number): SettledChargeResult {
  const charge =
    intent.latest_charge && typeof intent.latest_charge !== 'string' ? intent.latest_charge : null;
  const card = charge?.payment_method_details?.card ?? null;
  return {
    paymentRef: intent.id,
    amountCents:
      typeof intent.amount_received === 'number' && intent.amount_received > 0
        ? intent.amount_received
        : fallbackCents,
    cardBrand: card?.brand ?? null,
    cardLastFour: card?.last4 ?? null,
    cardholderName: charge?.billing_details?.name ?? null,
    receiptUrl: charge?.receipt_url ?? null,
  };
}

/** Map one Stripe event to our normalized event list (empty = intentionally ignored). */
function normalizeEvent(event: Stripe.Event): NormalizedPaymentEvent[] {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const intent = event.data.object as Stripe.PaymentIntent;
      return [{ type: 'payment_succeeded', paymentRef: intent.id }];
    }
    case 'payment_intent.payment_failed': {
      const intent = event.data.object as Stripe.PaymentIntent;
      return [{ type: 'payment_failed', paymentRef: intent.id }];
    }
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      const paymentRef =
        typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
      if (!paymentRef) return [];
      // Stripe sends the full Charge with its CUMULATIVE amount_refunded.
      return [
        { type: 'refund_completed', paymentRef, refundedTotalCents: charge.amount_refunded ?? 0 },
      ];
    }
    default:
      return [];
  }
}

/** Build a Stripe-backed PaymentProvider bound to one set of keys. */
export function createStripeProvider(config: StripeProviderConfig): PaymentProvider {
  const stripe = () => getStripeClient(config.secretKey);

  return {
    providerKey: 'stripe',

    isConfigured: () => Boolean(config.secretKey),

    clientConfig(): ClientPaymentConfig {
      // A secret key with no publishable key can settle server-side flows but the
      // browser has nothing to mount Elements with — say so instead of half-working.
      if (!config.publishableKey) return { kind: 'none' };
      return {
        kind: 'stripe-elements',
        publishableKey: config.publishableKey,
        testMode: config.publishableKey.startsWith('pk_test_'),
      };
    },

    async charge(input: ProviderChargeInput): Promise<ChargeOutcome> {
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

      let intent: Stripe.PaymentIntent;
      try {
        intent = await stripe().paymentIntents.create(
          {
            amount: input.amountCents,
            currency: CURRENCY,
            payment_method: input.tokenizedSource,
            confirm: true,
            // Server-side confirm with no redirect-based methods (card only for now).
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
            metadata: { orderId: input.orderId },
            description: `Order ${input.orderId}`,
            expand: ['latest_charge'],
          },
          { idempotencyKey: input.idempotencyKey },
        );
      } catch (err) {
        const mapped = toPaymentError(err);
        return {
          status: 'failed',
          failure: { message: mapped.message, code: mapped.code ?? null, httpStatus: mapped.status },
        };
      }

      if (intent.status === 'succeeded') {
        return { status: 'succeeded', ...settledFromIntent(intent, input.amountCents) };
      }

      if (intent.status === 'requires_action') {
        // THE 3DS FIX: keep the intent's id + client secret so the browser can run
        // the bank challenge through Stripe.js and /confirm can settle it.
        return {
          status: 'requires_action',
          amountCents: input.amountCents,
          challenge: {
            intentId: intent.id,
            clientSecret: intent.client_secret ?? null,
            returnUrl: null,
          },
        };
      }

      // requires_payment_method (declined), canceled, etc.
      return {
        status: 'failed',
        failure: {
          message: 'The card was declined. Please try a different card.',
          code: intent.status,
          httpStatus: 402,
        },
      };
    },

    async confirmChallenge({ intentId, action }): Promise<SettledChargeResult | null> {
      if (action === 'cancel') {
        // Best-effort: Stripe expires an unconfirmed intent on its own, and failing
        // to cancel it must not stop the caller releasing the guest's seats.
        try {
          await stripe().paymentIntents.cancel(intentId);
        } catch (err) {
          console.warn(`[payments] could not cancel intent ${intentId}:`, err);
        }
        return null;
      }

      // The browser already ran the bank's challenge through Stripe.js; re-read the
      // intent rather than trusting the client's word that it worked — "the
      // customer said the payment succeeded" is not a payment.
      let intent: Stripe.PaymentIntent;
      try {
        intent = await stripe().paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
      } catch (err) {
        throw toPaymentError(err);
      }
      if (intent.status !== 'succeeded') {
        throw new StripePaymentError(
          intent.status === 'requires_action'
            ? 'Your bank has not confirmed this payment yet. Please complete the check and try again.'
            : 'We could not authenticate this payment. Please try a different card.',
          402,
          intent.status,
        );
      }
      return settledFromIntent(intent, intent.amount);
    },

    // Stripe holds the intent state on its side; the client must send the intent
    // id it was given back with /confirm.
    async pendingChallenge(): Promise<string | null> {
      return null;
    },

    async refund(input: ProviderRefundInput): Promise<RefundOutcome> {
      if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
        throw new StripePaymentError('Refund amount must be a positive integer (cents)', 400);
      }
      try {
        const refund = await stripe().refunds.create(
          {
            payment_intent: input.paymentRef,
            amount: input.amountCents,
            // Stripe only accepts a fixed reason enum; keep the free-text in metadata.
            reason: 'requested_by_customer',
            ...(input.reason ? { metadata: { note: input.reason } } : {}),
          },
          { idempotencyKey: `refund-${input.paymentRef}-${input.amountCents}` },
        );
        return {
          refundRef: refund.id,
          status: refund.status ?? 'pending',
          amountCents: typeof refund.amount === 'number' ? refund.amount : input.amountCents,
        };
      } catch (err) {
        throw toPaymentError(err);
      }
    },

    verifyAndParseWebhook(rawBody, header): ParsedWebhook {
      let event: Stripe.Event;
      if (!config.webhookSecret) {
        // Dev: accept unverified so the flow can be exercised against the Stripe
        // CLI without a registered endpoint. (JSON.parse throws → route 400s.)
        event = JSON.parse(rawBody) as Stripe.Event;
      } else {
        const signature = header('stripe-signature');
        if (!signature) {
          throw new StripePaymentError('Missing Stripe signature', 401);
        }
        try {
          event = stripe().webhooks.constructEvent(rawBody, signature, config.webhookSecret);
        } catch {
          throw new StripePaymentError('Invalid Stripe signature', 401);
        }
      }
      return {
        providerEventId: event.id ?? null,
        providerEventType: event.type ?? null,
        events: normalizeEvent(event),
      };
    },
  };
}
