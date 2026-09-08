'use client';

/**
 * Stripe Elements implementation of the PaymentMethodInput contract.
 *
 * Loads Stripe.js with the public publishable key, mounts a hosted, PCI-safe
 * CardElement, and exposes `tokenize()` via the imperative handle so the checkout
 * can obtain a single-use PaymentMethod id at submit time and pass it to the
 * booking action (which charges it server-side via a PaymentIntent). No secrets
 * touch the browser: only the publishable key.
 */
import { forwardRef, useImperativeHandle, useMemo, useState } from 'react';
// loadStripe comes from the '/pure' entry on purpose. The default entry injects
// <script src="js.stripe.com/v3"> from MODULE SCOPE the microtask after import, so
// merely importing it downloads Stripe on every checkout - including local runs and
// any operator with no Stripe key. '/pure' exports the same function with no
// module-scope side effect; the script loads when (and only when) loadStripe is
// actually called.
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe } from '@stripe/stripe-js';
import { CardElement, Elements, useElements, useStripe } from '@stripe/react-stripe-js';
import { CreditCard, Lock } from 'lucide-react';
import type { PaymentMethodInputHandle } from './types';

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
 * imperative handle the checkout drives at submit time.
 */
const CardForm = forwardRef<PaymentMethodInputHandle, { testMode: boolean }>(
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
      }),
      [stripe, elements, ready],
    );

    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-ink">
          <CreditCard className="h-4 w-4" aria-hidden />
          Card details
          {testMode && (
            <span className="rounded bg-bg px-1.5 py-0.5 text-xs font-medium text-muted">
              Test
            </span>
          )}
        </div>

        {/* Stripe mounts its hosted, PCI-safe card iframe inside this element. */}
        <div className="min-h-[44px] rounded-lg border border-hairline bg-surface p-3">
          <CardElement
            options={CARD_ELEMENT_OPTIONS}
            onReady={() => setReady(true)}
            onChange={(e) => setFieldError(e.error?.message ?? null)}
          />
        </div>

        {!ready && <p className="text-sm text-muted">Loading secure card field…</p>}
        {fieldError && (
          <p role="alert" className="text-sm text-danger">
            {fieldError}
          </p>
        )}

        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          Your card is encrypted and processed securely. We never see your card number.
        </p>
      </div>
    );
  },
);

interface StripeElementsInputProps {
  publishableKey: string;
  testMode: boolean;
}

/** Stripe Elements card entry, self-contained behind the PaymentMethodInput handle. */
export const StripeElementsInput = forwardRef<PaymentMethodInputHandle, StripeElementsInputProps>(
  function StripeElementsInput({ publishableKey, testMode }, ref) {
    const stripePromise = useMemo<Promise<Stripe | null>>(
      () => loadStripe(publishableKey),
      [publishableKey],
    );
    return (
      <Elements stripe={stripePromise}>
        <CardForm ref={ref} testMode={testMode} />
      </Elements>
    );
  },
);
