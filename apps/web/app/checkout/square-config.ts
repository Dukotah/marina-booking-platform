/**
 * Resolves the Square Web Payments SDK configuration for the checkout page.
 *
 * Square's browser SDK needs three PUBLIC values — the application id, the location
 * id, and which environment (sandbox/production) to load — all surfaced by the API's
 * GET /api/payments/config when the resolved provider is Square. Nothing secret ever
 * reaches the browser (the access token is server-only).
 *
 * Mirrors `StripeConfig`: `configured` is true only when the browser has everything
 * it needs to mount the card form. Stripe stays the default path; this config is
 * populated ONLY when the API reports `kind: 'square-web-payments'`.
 */
export interface SquareConfig {
  /** True only when both the application id and location id are present. */
  configured: boolean;
  /** Square Application ID (sq0idp-… / sandbox sq0idb-…; safe to send to the browser). */
  applicationId: string | null;
  /** The Square location the payment is attributed to. */
  locationId: string | null;
  /** Which Square environment to load the Web Payments SDK for. */
  environment: 'sandbox' | 'production';
}

/** The "Square is not in play" config — the default for every non-Square deployment. */
export const EMPTY_SQUARE_CONFIG: SquareConfig = {
  configured: false,
  applicationId: null,
  locationId: null,
  environment: 'sandbox',
};
