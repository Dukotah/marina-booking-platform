'use client';

/**
 * Payment-method dispatcher — picks WHICH PaymentMethodInput the checkout mounts.
 *
 * The actual collection UIs live in ./payment-methods/, one per provider `kind`,
 * all speaking the same imperative `PaymentMethodInputHandle` contract
 * (`tokenize() → { sourceId }`). This component only decides which one applies:
 *
 *   - reserve mode          → ReserveAtMarinaInput (no card online, pay on arrival)
 *   - Stripe configured     → StripeElementsInput (hosted, PCI-safe card field)
 *   - sandbox/fake payments → ReserveAtMarinaInput (never surfaces "test" wording)
 *   - nothing configured    → NotConfiguredNotice (parent guards submit)
 *
 * Adding a new processor later = a new API provider file (apps/api/src/services/
 * payments/) + a new PaymentMethodInput component + a branch here keyed on the
 * provider config. See docs/PAYMENTS.md.
 */
import { forwardRef } from 'react';
import type { StripeConfig } from '@/app/checkout/stripe-config';
import { EMPTY_SQUARE_CONFIG, type SquareConfig } from '@/app/checkout/square-config';
import type { PaymentMethodInputHandle } from './payment-methods/types';
import { StripeElementsInput } from './payment-methods/StripeElementsInput';
import { SquareWebPaymentsInput } from './payment-methods/SquareWebPaymentsInput';
import { ReserveAtMarinaInput } from './payment-methods/ReserveAtMarinaInput';
import { NotConfiguredNotice } from './payment-methods/NotConfiguredNotice';

/** What the parent can ask of this section (the shared PaymentMethodInput handle). */
export type PaymentSectionHandle = PaymentMethodInputHandle;

interface PaymentSectionProps {
  stripe: StripeConfig;
  /**
   * Square Web Payments config. Live (configured) ONLY when the API's resolved
   * provider is Square; the default empty config means "Square not in play" and the
   * Stripe path is untouched.
   */
  square?: SquareConfig;
  /**
   * Reserve mode: hold the spot with no card taken online; the guest pays on
   * arrival. When true this renders the "Reserve now, pay at the marina" panel
   * regardless of Stripe wiring, and the parent never calls `tokenize`.
   */
  reserveMode?: boolean;
  /** Estimated amount owed at the marina (integer cents), shown in reserve mode. */
  dueAtMarinaCents?: number;
  /** Amount about to be charged (integer cents), forwarded to Square's verifyBuyer SCA. */
  amountCents?: number;
}

export const PaymentSection = forwardRef<PaymentSectionHandle, PaymentSectionProps>(
  function PaymentSection(
    { stripe, square = EMPTY_SQUARE_CONFIG, reserveMode, dueAtMarinaCents, amountCents },
    ref,
  ) {
    // --- Reserve mode: pay at the marina, no card online. This is a first-class,
    // customer-presentable mode (PAYMENT_MODE=reserve), independent of Stripe wiring.
    if (reserveMode) {
      return <ReserveAtMarinaInput ref={ref} dueCents={dueAtMarinaCents} />;
    }

    // --- Live card capture (Stripe Elements). Reserve mode never loads Stripe.js.
    if (stripe.configured && stripe.publishableKey) {
      return (
        <StripeElementsInput
          ref={ref}
          publishableKey={stripe.publishableKey}
          testMode={stripe.testMode}
        />
      );
    }

    // --- Live card capture (Square Web Payments). Selected only when the API's
    // resolved provider is Square; Stripe (above) always wins if also configured.
    if (square.configured && square.applicationId && square.locationId) {
      return (
        <SquareWebPaymentsInput
          ref={ref}
          applicationId={square.applicationId}
          locationId={square.locationId}
          environment={square.environment}
          amountCents={amountCents}
        />
      );
    }

    // --- No online card capture but not reserve mode (local simulator with no key):
    // still present it as reserve-now, pay-at-the-marina — never as a dev/fake charge.
    if (stripe.fakeMode) {
      return <ReserveAtMarinaInput ref={ref} dueCents={dueAtMarinaCents} />;
    }

    // --- Not configured: clear notice (no card field). The parent guards submit on
    // stripe.configured, so the imperative ref is never used in this state. --------
    return <NotConfiguredNotice />;
  },
);
