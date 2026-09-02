/**
 * Payment mode for the customer checkout — "card" or "reserve".
 *
 *   card    — collect a card online at checkout and charge it (Stripe, or the
 *             local simulator when no key is configured). The order is paid on
 *             confirmation.
 *   reserve — no card is taken online. The reservation is created with the full
 *             amount left as balance due, and the guest pays when they arrive
 *             ("Reserve now, pay at the marina"). Staff collect the balance at
 *             check-in via the existing collect-balance / at-the-marina flow.
 *
 * This is a per-deployment (and, via env, effectively per-operator) config
 * choice, NOT a dev/test switch — reserve mode is a real, customer-presentable
 * way to run a marina that takes payment on arrival. Nothing here ever surfaces
 * dev/fake/test wording to a guest.
 *
 * Resolution order (first non-empty wins), defaulting to "card":
 *   1. PAYMENT_MODE               (server-authoritative)
 *   2. NEXT_PUBLIC_PAYMENT_MODE   (so the value is also available in the browser
 *                                  bundle; harmless to expose — it is not a secret)
 *
 * Pure (no imports) so it is safe in both server and client bundles.
 */

export type PaymentMode = 'card' | 'reserve';

function normalize(value: string | undefined): PaymentMode | null {
  const v = value?.trim().toLowerCase();
  if (v === 'reserve') return 'reserve';
  if (v === 'card') return 'card';
  return null;
}

/**
 * Resolve the active payment mode. Defaults to "card" (take payment online) when
 * unset or set to anything unrecognized, so a typo never silently stops a site
 * from collecting money.
 */
export function getPaymentMode(): PaymentMode {
  return (
    normalize(process.env.PAYMENT_MODE) ??
    normalize(process.env.NEXT_PUBLIC_PAYMENT_MODE) ??
    'card'
  );
}
