/**
 * Wallet-pay (Apple Pay / Google Pay) configuration for express checkout.
 *
 * This resolves *which wallet driver the browser should run*, mirroring the
 * provider-seam rule in docs/LOCAL-FIRST-BUILD.md §4.1: one interface, a `local`
 * driver and a `cloud` driver, chosen by `SANDBOX`.
 *
 *   - `mode: 'stripe'` — a publishable key is present and we are NOT sandboxed, so
 *     the browser hands the wallet off to Stripe.js, which owns the Apple Pay
 *     merchant session and the Google Pay gateway. That path needs an account.
 *   - `mode: 'sandbox'` — everything else. The wallet is exercised through the
 *     browser PaymentRequest API against the local payment simulator, so the whole
 *     express path is testable on the owner's laptop with no account anywhere.
 *
 * A publishable key present *and* `SANDBOX=local` still resolves to `sandbox`:
 * "local" means local, and a sandbox run must never pop a real wallet sheet that
 * charges a real card.
 *
 * This runs on the server (it reads `SANDBOX`, which is server-only) and the
 * resolved, non-secret config is passed to the client as a prop. Resilience
 * mirrors stripe-config: a disabled/unconfigured wallet is a clean no-op that
 * renders nothing and never throws.
 */

import { getBrand } from '@/lib/brand';

/** Which wallet driver the browser should run. */
export type WalletMode = 'sandbox' | 'stripe';

export interface WalletConfig {
  /** True only when express-wallet checkout should be attempted at all. */
  enabled: boolean;
  /** Sandbox (local simulator) vs. Stripe (real wallet, real money). */
  mode: WalletMode;
  /** Stripe publishable key — only ever set, and only ever used, in `stripe` mode. */
  publishableKey: string | null;
  /** ISO-3166 alpha-2 country of the merchant account. Stripe requires it verbatim. */
  country: string;
  /** Lowercase ISO-4217 settlement currency. */
  currency: string;
  /** Operator name shown on the wallet sheet — white-label, never the platform's. */
  merchantName: string;
}

function clean(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

function isFlagOn(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

function isFlagOff(value: string | undefined): boolean {
  return value === 'false' || value === '0';
}

/**
 * Is this a sandbox run? Same resolution as the API's `sandboxEnabled()` so the
 * browser and the server can never disagree about which driver is live:
 *
 *   SANDBOX=local -> yes, SANDBOX=cloud -> no, unset -> yes outside production.
 *
 * The unset default is deliberately "no" in production: a deploy that forgets to
 * set SANDBOX must fall through to the real processor, never quietly settle a
 * paying customer's wallet against a simulator.
 */
function isSandboxRun(): boolean {
  const flag = process.env.SANDBOX?.trim().toLowerCase();
  if (flag === 'local') return true;
  if (flag === 'cloud') return false;
  return process.env.NODE_ENV !== 'production';
}

/** Two-letter country, uppercased. Falls back to US on anything malformed. */
function safeCountry(value: string | null): string {
  return value && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : 'US';
}

/** Three-letter currency, lowercased (Stripe's convention). Falls back to usd. */
function safeCurrency(value: string | null): string {
  return value && /^[A-Za-z]{3}$/.test(value) ? value.toLowerCase() : 'usd';
}

/**
 * Resolve the wallet config for the checkout page.
 *
 * `NEXT_PUBLIC_ENABLE_WALLET_PAY` is a three-state switch, not a boolean:
 * explicitly on forces it on, explicitly off forces it off, and *unset* follows
 * the sandbox — so `pnpm dev:local` shows the wallet without the owner having to
 * discover an env var, while a cloud deploy has to opt in on purpose.
 *
 * @param merchantName overrides the name on the wallet sheet; defaults to the
 *   resolved tenant brand so the sheet reads as the operator, not the platform.
 */
export function getWalletConfig(merchantName?: string): WalletConfig {
  const sandbox = isSandboxRun();
  const flag = process.env.NEXT_PUBLIC_ENABLE_WALLET_PAY;

  const enabled = isFlagOn(flag) ? true : isFlagOff(flag) ? false : sandbox;

  const publishableKey =
    clean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) ??
    clean(process.env.STRIPE_PUBLISHABLE_KEY);

  const mode: WalletMode = !sandbox && publishableKey ? 'stripe' : 'sandbox';

  return {
    enabled,
    mode,
    // Never ship the key to the browser in sandbox mode — nothing there may use it.
    publishableKey: mode === 'stripe' ? publishableKey : null,
    country: safeCountry(clean(process.env.NEXT_PUBLIC_WALLET_COUNTRY)),
    currency: safeCurrency(clean(process.env.NEXT_PUBLIC_WALLET_CURRENCY)),
    merchantName: clean(merchantName) ?? getBrand().name,
  };
}
