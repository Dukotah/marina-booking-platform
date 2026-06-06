'use client';

/**
 * Stripe Elements card entry.
 *
 * Loads Stripe.js with the public publishable key, mounts a hosted, PCI-safe
 * CardElement, and exposes a `tokenize()` method via an imperative ref so the
 * parent can obtain a single-use PaymentMethod id at submit time and pass it to
 * the booking action (which charges it server-side via a PaymentIntent).
 *
 * 3-D Secure / SCA: when the server reports REQUIRES_ACTION, the parent calls
 * `confirmAction(clientSecret)` (also exposed on the imperative handle). Because
 * Stripe.js lives here in the browser, this is where `handleNextAction` runs to
 * show the 3DS modal — a server action cannot. On success the parent finalizes via
 * the `finalizePayment` server action. See CheckoutClient.onSubmit for the wiring.
 *
 * When Stripe is not configured (no publishable key — the common early dev
 * state), it renders a clear "payments not configured" notice instead of a card
 * field; the parent guards submit on `stripe.configured`, so `tokenize()` is never
 * called in that state. No secrets touch the browser: only the publishable key.
 */
import { forwardRef, useImperativeHandle, useMemo, useState } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import {
  CardElement,
  Elements,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { AlertTriangle, CreditCard, Lock } from 'lucide-react';
import type { StripeConfig } from '@/app/checkout/stripe-config';

/** What the parent can ask of this section. */
export interface PaymentSectionHandle {
  /**
   * Tokenize the entered card. Returns the PaymentMethod id (as `sourceId`) on
   * success, or an object describing why it could not (so the parent shows a msg).
   */
  tokenize: () => Promise<
    { ok: true; sourceId: string } | { ok: false; error: string }
  >;
  /**
   * Run the 3-D Secure / SCA challenge for a PaymentIntent that came back
   * REQUIRES_ACTION. Calls Stripe.js `handleNextAction(clientSecret)` to show the
   * modal in the browser. Resolves `{ ok: true }` once the cardholder completes it
   * (the intent is then succeeded/processing server-side), or `{ ok: false }` if
   * they cancel or it fails — the parent then finalizes / shows the decline UX.
   */
  confirmAction: (
    clientSecret: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** True when a live, ready-to-tokenize card field is mounted. */
  isReady: () => boolean;
}

interface PaymentSectionProps {
  stripe: StripeConfig;
}

const CARD_ELEMENT_OPTIONS = {
  style: {
    base: {
      fontSize: '16px',
      color: '#0f172a',
      '::placeholder': { color: '#94a3b8' },
    },
    invalid: { color: '#dc2626' },
  },
};

/**
 * Inner form — lives inside <Elements> so it can use the Stripe hooks. Exposes the
 * imperative handle the parent drives at submit time.
 */
const CardForm = forwardRef<PaymentSectionHandle, { testMode: boolean }>(
  function CardForm({ testMode }, ref) {
    const stripe = useStripe();
    const elements = useElements();
    const [ready, setReady] = useState(false);
    const [fieldError, setFieldError] = useState<string | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        isReady: () => Boolean(stripe && elements && ready),
        tokenize: async () => {
          if (!stripe || !elements) {
            return { ok: false, error: 'The payment form is not ready yet. Please wait a moment.' };
          }
          const card = elements.getElement(CardElement);
          if (!card) {
            return { ok: false, error: 'The payment form is not ready yet. Please wait a moment.' };
          }
          const { error, paymentMethod } = await stripe.createPaymentMethod({
            type: 'card',
            card,
          });
          if (error || !paymentMethod) {
            return {
              ok: false,
              error: error?.message ?? 'Please check your card details and try again.',
            };
          }
          return { ok: true, sourceId: paymentMethod.id };
        },
        confirmAction: async (clientSecret: string) => {
          if (!stripe) {
            return { ok: false, error: 'The payment form is not ready yet. Please try again.' };
          }
          // Shows the bank's 3DS modal; resolves once the cardholder completes (or
          // cancels) the challenge. handleNextAction does not capture the funds —
          // the server /confirm step does, after reading the updated intent.
          const { error } = await stripe.handleNextAction({ clientSecret });
          if (error) {
            return {
              ok: false,
              error: error.message ?? 'Card authentication was not completed. Please try again.',
            };
          }
          return { ok: true };
        },
      }),
      [stripe, elements, ready],
    );

    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <CreditCard className="h-4 w-4" aria-hidden />
          Card details
          {testMode && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-500">
              Test
            </span>
          )}
        </div>

        {/* Stripe mounts its hosted, PCI-safe card iframe inside this element. */}
        <div className="min-h-[44px] rounded-md border border-slate-300 bg-white p-3">
          <CardElement
            options={CARD_ELEMENT_OPTIONS}
            onReady={() => setReady(true)}
            onChange={(e) => setFieldError(e.error?.message ?? null)}
          />
        </div>

        {!ready && <p className="text-sm text-slate-500">Loading secure card field…</p>}
        {fieldError && (
          <p role="alert" className="text-sm text-red-600">
            {fieldError}
          </p>
        )}

        <p className="flex items-center gap-1.5 text-xs text-slate-400">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          Your card is encrypted and processed securely. We never see your card number.
        </p>
      </div>
    );
  },
);

export const PaymentSection = forwardRef<PaymentSectionHandle, PaymentSectionProps>(
  function PaymentSection({ stripe }, ref) {
    // Hooks must run unconditionally — build the Stripe instance (null if unconfigured).
    const stripePromise = useMemo<Promise<Stripe | null> | null>(
      () => (stripe.configured && stripe.publishableKey ? loadStripe(stripe.publishableKey) : null),
      [stripe.configured, stripe.publishableKey],
    );

    // --- Not configured: clear notice (no card field). The parent guards submit on
    // stripe.configured, so the imperative ref is never used in this state. --------
    if (!stripePromise) {
      return (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-amber-900">Payments not configured</p>
              <p className="text-amber-800">
                Card payments are not set up for this site yet. Add a Stripe publishable
                key to enable secure checkout. Until then, bookings cannot be paid online
                here.
              </p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <Elements stripe={stripePromise}>
        <CardForm ref={ref} testMode={stripe.testMode} />
      </Elements>
    );
  },
);
