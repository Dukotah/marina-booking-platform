# Square go-live checklist

Square is wired as a **seam only**. The provider
(`apps/api/src/services/payments/square-provider.ts`) conforms to the
`PaymentProvider` interface and does every piece of work that does not need the
Square SDK — amount validation, client-config shaping, money conversion, webhook
payload parsing + event normalization. Every spot that needs a real Square API call
**throws `SquareNotConfiguredError` (HTTP 501, "Square live integration not
configured")** rather than returning a fake success, so an unfinished install can
never masquerade as a real charge.

Stripe stays the default. Square is selected **only** when `PAYMENT_PROVIDER=square`
is set with a Square access token present. The local sandbox still supersedes
everything in non-production runs.

## 1. Environment variables

Set these on the **API** deployment (and the public ones on the **web** deployment
so the browser can mount the card form):

| Var | Where | Purpose |
|---|---|---|
| `PAYMENT_PROVIDER=square` | API | **The selector.** Nothing else turns Square on. |
| `SQUARE_ACCESS_TOKEN` | API only (secret) | Server-side Payments/Refunds credential. |
| `SQUARE_ENVIRONMENT` | API + web | `sandbox` (default) or `production` — picks the Square API host + which Web Payments SDK the browser loads. |
| `SQUARE_APPLICATION_ID` / `NEXT_PUBLIC_SQUARE_APPLICATION_ID` | web (public) | Needed by the browser Web Payments SDK. |
| `SQUARE_LOCATION_ID` / `NEXT_PUBLIC_SQUARE_LOCATION_ID` | API + web (public) | Location the payment is attributed to. Required to charge. |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | API only (secret) | Enables webhook signature verification. When set, unverified bodies are rejected. |

Notes:
- `isConfigured()` requires **both** the access token and a location id.
- `clientConfig()` returns `kind: 'none'` (card cannot be collected) unless both the
  application id and location id are present.
- Mirror the Stripe cutover rule: set `SANDBOX=cloud` so the local simulator does not
  supersede Square (see `docs/PROVIDER-MATRIX.md`).

## 2. SDK

Add the official **`square`** Node SDK (`npm i square`) to `apps/api`. Keep every
Square SDK type confined to `square-provider.ts` (and an optional `services/square.ts`
low-level driver mirroring `services/stripe.ts`) — nothing Square-shaped may leak
past `services/payments/types.ts`, exactly like the Stripe containment.

## 3. Methods to fill in (search `// TODO(square-golive):`)

All live in `apps/api/src/services/payments/square-provider.ts`:

1. **`charge()`** — `client.payments.create({ sourceId, idempotencyKey, amountMoney,
   locationId, referenceId, note })`, then map the Square `Payment` to the seam's
   `ChargeOutcome` (COMPLETED/APPROVED → `succeeded`; declined → `failed` 402). The
   amount (`toSquareMoney`) and idempotency key are already derived. **No 3DS
   `requires_action` branch**: Square runs SCA in the browser via
   `payments.verifyBuyer(...)` before tokenizing, so the server charge has no
   challenge state.
2. **`refund()`** — `client.refunds.refundPayment({ idempotencyKey, paymentId,
   amountMoney, reason })`, map the Square `Refund` to `RefundOutcome` (lower-case
   the status to the seam's `succeeded`/`pending` convention).
3. **`verifyAndParseWebhook()`** — the signed path throws until you wire
   `WebhooksHelper.verifySignature({ requestBody, signatureHeader, signatureKey,
   notificationUrl })`. Parsing + event normalization (`normalizeSquareEvent`) are
   already done. **Do not remove the throw before the real check is in place** — an
   accepted unverified signed webhook lets anyone post a fake `payment_succeeded`.
   Also resolve the **cumulative** refunded total per payment (Square's refund object
   carries only this refund's amount, unlike Stripe's running `amount_refunded`).
4. **`confirmChallenge('complete')`** — not applicable to Square's standard card
   flow; only implement if a future async-confirm method (ACH/gift card) needs it.
   `confirmChallenge('cancel')` and `pendingChallenge()` are already correct no-ops.

## 4. Webhook setup

In the Square Developer dashboard, add a webhook subscription pointing at the API's
public `/api/payments/webhook` URL (the same endpoint the Stripe webhook uses — the
resolver picks the provider from env). Subscribe to `payment.updated`,
`payment.created`, `refund.updated`, `refund.created`. Copy the **signature key**
into `SQUARE_WEBHOOK_SIGNATURE_KEY`. The `notificationUrl` passed to
`verifySignature` must be the exact absolute URL you registered.

## 5. Client (browser) work

Add a `square-web-payments` `PaymentMethodInput` component under
`apps/web/components/checkout/payment-methods/` that mounts the Square Web Payments
SDK card form (using the `applicationId` + `locationId` + `environment` returned by
`GET /api/payments/config`), tokenizes the card into the `sourceId` nonce, runs
`payments.verifyBuyer(...)` for SCA, and submits that nonce as `tokenizedSource`.

## 6. Apple Pay / Google Pay via Square — STUB (further step)

Square Web Payments supports Apple Pay and Google Pay as additional payment methods
on the same SDK. This is **intentionally left as a documented stub**: it requires
(a) Apple Pay domain verification with Square, (b) a `payments.walletButton`/digital-
wallet flow in the web card component, and (c) no server change beyond what the card
`charge()` already does (the wallet also yields a `sourceId` nonce). Implement the
card flow (§3–§5) first; add wallets afterward as a web-only follow-up.
