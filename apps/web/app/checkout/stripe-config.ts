/**
 * Resolves the Stripe.js configuration for the checkout page.
 *
 * Stripe's browser SDK needs only a public publishable key. It is read from env so
 * it stays per-deployment configurable and is never hardcoded. When it is absent
 * (the common case during early development), the checkout renders a clearly
 * labelled "payments not configured" notice instead of a live card field.
 *
 * This runs on the server (it reads env) and the resolved, non-secret publishable
 * key is passed down to the client payment component as a prop. No secret key ever
 * reaches the browser.
 */

export interface StripeConfig {
  /** True only when a publishable key is present. */
  configured: boolean;
  /** Stripe publishable key (pk_test_… / pk_live_…; safe to send to the browser). */
  publishableKey: string | null;
  /** Test mode when the key is a pk_test_ key — drives the "Test" badge. */
  testMode: boolean;
  /**
   * Dev-only: no Stripe key but NEXT_PUBLIC_DEV_FAKE_PAYMENTS=true → simulate the
   * payment (the API runs its matching fake-payments mode). Lets checkout complete
   * end-to-end locally with no Stripe account.
   */
  fakeMode: boolean;
}

function clean(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

export function getStripeConfig(): StripeConfig {
  const publishableKey =
    clean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) ??
    clean(process.env.STRIPE_PUBLISHABLE_KEY);

  const fakeMode =
    !publishableKey && process.env.NEXT_PUBLIC_DEV_FAKE_PAYMENTS === 'true';

  return {
    configured: Boolean(publishableKey),
    publishableKey,
    testMode: publishableKey ? publishableKey.startsWith('pk_test_') : true,
    fakeMode,
  };
}
