/**
 * Wallet-pay (Apple Pay / Google Pay) readiness seam.
 *
 * This is a *seam*, not an integration: it resolves whether the express-wallet UI
 * should be offered, gated behind an explicit flag, so the real
 * PaymentRequest/Stripe-wallet wiring can be dropped in later without touching the
 * checkout layout. Until the flag is on it stays completely inert — no wallet
 * button renders, no browser wallet API is touched.
 *
 * Enable by setting NEXT_PUBLIC_ENABLE_WALLET_PAY=true (and, for the real thing, a
 * Stripe publishable key). Resilience mirrors stripe-config: absent/false flag →
 * clean no-op, never throws.
 */

export interface WalletConfig {
  /**
   * True only when the express-wallet seam is explicitly enabled. Wallet UI must
   * render nothing at all unless this is true.
   */
  enabled: boolean;
}

function isFlagOn(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export function getWalletConfig(): WalletConfig {
  return {
    enabled: isFlagOn(process.env.NEXT_PUBLIC_ENABLE_WALLET_PAY),
  };
}
