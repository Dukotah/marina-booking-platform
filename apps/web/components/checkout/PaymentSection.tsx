'use client';

/**
 * Stripe Elements card entry.
 *
 * Loads Stripe.js with the public publishable key, mounts a hosted, PCI-safe
 * CardElement, and exposes a `tokenize()` method via an imperative ref so the
 * parent can obtain a single-use PaymentMethod id at submit time and pass it to
 * the booking action (which charges it server-side via a PaymentIntent).
 *
 * When Stripe is not configured (no publishable key — the common early dev
 * state), it renders a clear "payments not configured" notice instead of a card
 * field; the parent guards submit on `stripe.configured`, so `tokenize()` is never
 * called in that state. No secrets touch the browser: only the publishable key.
 */
import { forwardRef, useImperativeHandle, useMemo, useState } from 'react';
// loadStripe comes from the '/pure' entry on purpose. The default entry injects
// <script src="js.stripe.com/v3"> from MODULE SCOPE the microtask after import, so
// merely importing it downloads Stripe on every checkout - including local runs and
// any operator with no Stripe key, where the `configured` guard below is false and
// makes no difference because the request has already been queued. '/pure' exports
// the same function with no module-scope side effect; the script loads when (and
// only when) loadStripe is actually called.
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe } from '@stripe/stripe-js';
import {
  CardElement,
  Elements,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { AlertTriangle, CreditCard, Lock } from 'lucide-react';
import { formatUSD } from '@marina/core';
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
  /** True when a live, ready-to-tokenize card field is mounted. */
  isReady: () => boolean;
}

interface PaymentSectionProps {
  stripe: StripeConfig;
  /**
   * Reserve mode: hold the spot with no card taken online; the guest pays on
   * arrival. When true this renders the "Reserve now, pay at the marina" panel
   * regardless of Stripe wiring, and the parent never calls `tokenize`.
   */
  reserveMode?: boolean;
  /** Estimated amount owed at the marina (integer cents), shown in reserve mode. */
  dueAtMarinaCents?: number;
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

/**
 * No-card reservation panel — booking without online card entry. Exposes the same
 * imperative handle as the live form, returning a placeholder source the API's
 * no-card path accepts, and presents the flow to the guest as a reserve-now,
 * pay-at-the-marina booking. Customer-facing copy NEVER mentions dev/simulated/
 * fake/test payments. Rendered when online card capture isn't wired for this site.
 */
const ReserveAtMarinaForm = forwardRef<PaymentSectionHandle, { dueCents?: number }>(
  function ReserveAtMarinaForm({ dueCents }, ref) {
    // No card is taken here — the parent skips tokenize entirely in reserve mode —
    // but the handle is still satisfied so the ref contract holds.
    useImperativeHandle(
      ref,
      () => ({
        isReady: () => true,
        tokenize: async () => ({ ok: true as const, sourceId: '' }),
      }),
      [],
    );
    return (
      <div className="rounded-lg border border-sky-300 bg-sky-50 p-4">
        <div className="flex items-start gap-3">
          <CreditCard className="mt-0.5 h-5 w-5 shrink-0 text-sky-600" aria-hidden />
          <div className="space-y-2 text-sm">
            <p className="font-semibold text-sky-900">Reserve now, pay at the marina</p>
            <p className="text-sky-800">
              No card needed to hold your spot. Confirm your booking below and pay
              when you arrive.
            </p>
            {typeof dueCents === 'number' && dueCents > 0 && (
              <p className="flex items-baseline justify-between gap-4 rounded-md bg-white/70 px-3 py-2 font-medium text-sky-900">
                <span>Due at the marina</span>
                <span className="tabular-nums">{formatUSD(dueCents)}</span>
              </p>
            )}
            <p className="text-xs text-sky-700">
              Bring a photo ID and your order number. Cash and card are accepted at
              check-in.
            </p>
          </div>
        </div>
      </div>
    );
  },
);

export const PaymentSection = forwardRef<PaymentSectionHandle, PaymentSectionProps>(
  function PaymentSection({ stripe, reserveMode, dueAtMarinaCents }, ref) {
    // Hooks must run unconditionally — build the Stripe instance (null if unconfigured).
    const stripePromise = useMemo<Promise<Stripe | null> | null>(
      () =>
        // Reserve mode never loads Stripe.js — no card is taken online.
        !reserveMode && stripe.configured && stripe.publishableKey
          ? loadStripe(stripe.publishableKey)
          : null,
      [reserveMode, stripe.configured, stripe.publishableKey],
    );

    // --- Reserve mode: pay at the marina, no card online. This is a first-class,
    // customer-presentable mode (PAYMENT_MODE=reserve), independent of Stripe wiring.
    if (reserveMode) {
      return <ReserveAtMarinaForm ref={ref} dueCents={dueAtMarinaCents} />;
    }

    // --- No online card capture but not reserve mode (local simulator with no key):
    // still present it as reserve-now, pay-at-the-marina — never as a dev/fake charge.
    if (!stripePromise && stripe.fakeMode) {
      return <ReserveAtMarinaForm ref={ref} dueCents={dueAtMarinaCents} />;
    }

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
