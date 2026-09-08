/**
 * The client-side payment-method seam.
 *
 * A `PaymentMethodInput` is one way of collecting a payment source in the browser
 * — Stripe Elements, the sandbox/reserve panel, or a future processor's SDK. Every
 * implementation renders its own UI and exposes the SAME imperative handle, so the
 * checkout orchestrator (CheckoutClient) drives them identically at submit time:
 * `tokenize()` and pass the returned `sourceId` to the API's /charge.
 *
 * This is the client half of the provider seam (the server half is
 * apps/api/src/services/payments). Adding a processor = one API provider file +
 * one component implementing this handle + a catalog entry. See docs/PAYMENTS.md.
 */

/** What the checkout can ask of any payment-method input. */
export interface PaymentMethodInputHandle {
  /**
   * Tokenize the entered payment method. Returns the provider token (as
   * `sourceId`) on success, or an object describing why it could not (so the
   * parent shows a message). Must never throw.
   */
  tokenize: () => Promise<{ ok: true; sourceId: string } | { ok: false; error: string }>;
  /** True when a live, ready-to-tokenize input is mounted. */
  isReady: () => boolean;
}
