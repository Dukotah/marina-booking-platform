# Payments — the provider seam

How money moves through the platform, and exactly what it takes to plug in a
payment processor. The design goal: **the routes, the booking service and the
checkout know no processor.** Stripe, the local sandbox simulator, and "payments
off" are three implementations of one interface; a fourth processor is a new
implementation, not a rewrite.

All money is integer USD cents everywhere.

---

## 1. Architecture

### Server (apps/api/src/services/payments/)

| File | Role |
| --- | --- |
| `types.ts` | The `PaymentProvider` interface + every shape that crosses it (`ChargeOutcome`, `RefundOutcome`, `NormalizedPaymentEvent`, `ClientPaymentConfig`) and the error classes (`PaymentProviderError`, `PaymentsNotConfiguredError`, `PaymentChallengeRequiredError`). **No processor SDK types may appear here.** |
| `stripe-provider.ts` | Stripe implementation (PaymentIntents). The only file, with `../stripe.ts`, where the Stripe SDK appears. |
| `sandbox-provider.ts` | The no-account driver: wraps the full local simulator (`../payments-sandbox.ts` — scripted declines, 3DS, timeouts, disputes) and the crude `DEV_FAKE_PAYMENTS` always-succeed fake. |
| `index.ts` | The resolver — picks the provider per operator (§2) — plus `getWebhookProvider()`, `paymentsEnabledFor()`, and re-exports of the legacy env helpers (`arePaymentsEnabled` etc.). |

The interface, abridged:

```ts
interface PaymentProvider {
  providerKey: 'stripe' | 'sandbox' | 'none';
  isConfigured(): boolean;
  clientConfig(): ClientPaymentConfig;          // what the BROWSER needs (never a secret)
  charge(input): Promise<ChargeOutcome>;        // 'succeeded' | 'requires_action' | 'failed'
  confirmChallenge({intentId, action, operatorId}); // finish/abandon a 3DS challenge
  pendingChallenge({orderId, operatorId});      // sandbox answers locally; Stripe → null
  refund(input): Promise<RefundOutcome>;
  verifyAndParseWebhook(rawBody, header): ParsedWebhook; // → normalized events
}
```

Contract points:

- **Expected payment outcomes are return values, not exceptions.** `charge()`
  returns `succeeded` / `requires_action` (with `{intentId, clientSecret,
  returnUrl}`) / `failed` (with `{message, code, httpStatus}` the route
  serializes verbatim). Only configuration faults and genuinely unexpected
  failures throw. Service-layer callers that cannot answer a challenge
  (deposits in `booking.ts`, balance collection, membership purchase) narrow
  with `settledOrThrow(outcome)`, which restores the historical throw behavior.
- **The seam is the provider call, not the ledger.** `recordSettledCharge` in
  `routes/payments.ts` and every Payment/Order/OrderEvent write are untouched
  and stay inside one tenant-scoped (RLS) transaction. Providers never touch
  the database (the sandbox's own attempt tables aside).
- **Webhooks are normalized** to three facts the ledger reacts to:
  `payment_succeeded`, `payment_failed`, `refund_completed` (with the
  **cumulative** refunded total, so retries are idempotent). Everything else is
  acknowledged and ignored. `/webhooks/stripe` is kept as the mount path for
  back-compat; internally it is `getWebhookProvider().verifyAndParseWebhook`.

### Client (apps/web)

- `GET /api/payments/config` (public, tenant-scoped) returns
  `{provider, enabled, paymentMode, client: ClientPaymentConfig}` where `client`
  is `{kind:'stripe-elements', publishableKey, testMode}` | `{kind:'sandbox'}` |
  `{kind:'none'}`.
- `app/checkout/payment-config.ts` (`getPaymentConfig()`) reads that endpoint —
  **the API is the source of truth for the publishable key** — and falls back to
  the env (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `PAYMENT_MODE`) when the API is
  unreachable or in `DEMO_MODE`, so nothing breaks without it.
- `components/checkout/payment-methods/` is the client half of the seam. Every
  collection UI implements one contract (`types.ts`):

  ```ts
  interface PaymentMethodInputHandle {
    tokenize(): Promise<{ok:true; sourceId:string} | {ok:false; error:string}>;
    isReady(): boolean;
  }
  ```

  Implementations: `StripeElementsInput` (hosted CardElement),
  `ReserveAtMarinaInput` (reserve mode AND the sandbox path — customer copy
  never says "test"), `NotConfiguredNotice`. `PaymentSection.tsx` is only the
  dispatcher that picks one.

---

## 2. Provider resolution order

Resolved per request/operator by `getPaymentProvider(operatorId)`:

1. **Local sandbox** — whenever the simulator is enabled (`sandboxEnabled()`:
   `SANDBOX=local`, or **any non-production run by default**). This deliberately
   supersedes real keys: a local run must never move real money. Set
   `SANDBOX=cloud` to exercise real Stripe from a dev machine.
2. **Per-operator Integration record** — the admin Settings → Integrations
   `stripe` entry, when `enabled` with a `secret_key` (fields: `secret_key`,
   `publishable_key`, `webhook_secret` — see
   `apps/admin/components/settings/integrationCatalog.ts`). True multi-tenant:
   each operator can bring their own Stripe account, no env change, no deploy.
3. **Env keys** — `STRIPE_SECRET_KEY` (single-tenant/platform deployment).
4. **Sandbox (crude fake)** — `DEV_FAKE_PAYMENTS=true` (non-production, no
   Stripe key): every charge succeeds instantly.
5. **None** — payments are off; `/charge`, `/confirm`, `/:id/refund` answer a
   clean 501 and `clientConfig()` is `{kind:'none'}`.

Covered by `apps/api/test/payments-provider-resolution.test.ts`.

Webhooks arrive with no tenant context, so `getWebhookProvider()` resolves with
env/sandbox only (steps 1, 3–5). *Known limitation:* a per-operator
`webhook_secret` is not consulted for inbound webhooks yet — that needs
per-operator endpoint paths; until then, operators using their own Stripe
account should rely on the platform-level `STRIPE_WEBHOOK_SECRET` endpoint or
run without inbound webhooks (the charge/refund flows do not depend on them).

## 3. Env vars

| Var | Where | Meaning |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | API | Enables the Stripe provider (env tier). |
| `STRIPE_WEBHOOK_SECRET` | API | Verifies `/webhooks/stripe` signatures; unset = parsed unverified (dev/Stripe CLI). |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (or `STRIPE_PUBLISHABLE_KEY`) | API + web | Browser key. Served by `/api/payments/config`; the web env copy is only the fallback. |
| `SANDBOX` | API | `local` forces the simulator, `cloud` disables it; unset = simulator on outside production. |
| `DEV_FAKE_PAYMENTS` / `NEXT_PUBLIC_DEV_FAKE_PAYMENTS` | API / web | Crude always-succeed fake when no key is configured (never in production). |
| `PAYMENT_MODE` / `NEXT_PUBLIC_PAYMENT_MODE` | API + web | `card` (default) or `reserve` (no card online, pay on arrival). |

## 4. Plugging in a new processor

1. **API adapter** — `apps/api/src/services/payments/acme-provider.ts`
   implementing `PaymentProvider`. Keep the SDK's types inside this file. Map
   your intents/charges onto `ChargeOutcome` (put the processor's charge handle
   in `paymentRef` — it lands in `Payment.processor_transaction_id`) and your
   webhook events onto the three normalized types.
2. **Resolver entry** — add its Integration key lookup / env tier to
   `payments/index.ts` where the Stripe tiers live.
3. **Client input component** — a new `kind` in `ClientPaymentConfig` +
   `apps/web/components/checkout/payment-methods/AcmeInput.tsx` implementing
   `PaymentMethodInputHandle` (`tokenize() → {sourceId}`), and a branch in
   `PaymentSection.tsx` / the `fromApi` mapping in `app/checkout/payment-config.ts`.
4. **Catalog entry** — `apps/admin/components/settings/integrationCatalog.ts`
   so operators can enter their keys in the admin.
5. **Webhook mount** — a route in `apps/api/src/routes/webhooks.ts`
   (e.g. `POST /webhooks/acme`) that resolves your provider and reuses
   `applyPaymentEvent`.

That's the whole surface. Routes, ledger writes, refund approval gates,
idempotency handling, and the checkout orchestration all come for free.

*Note:* the `Payment.processor` column currently records `'STRIPE'` for every
provider (including the sandbox, which predates the seam and emits
Stripe-shaped ids). Widening that enum is a migration and deliberately out of
scope for the seam refactor.

## 5. Go-live with Stripe (test mode first)

The step-by-step is in `docs/GO-LIVE-DELTA.md` Stage 1. Summary: create the
Stripe account → add the webhook endpoint (`https://<api-host>/webhooks/stripe`)
→ set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` → set `SANDBOX=cloud` on the API (or it
will keep simulating) → clear `PAYMENT_MODE=reserve` / `DEV_FAKE_PAYMENTS` →
verify with `4242 4242 4242 4242` **and** the 3DS card `4000 0027 6000 3184`.
Alternatively, put the keys in the operator's admin **Settings → Integrations →
Stripe** record instead of env — same effect, no redeploy.

## 6. The 3-D Secure fix (2026-09)

The pre-seam Stripe driver discarded the PaymentIntent whenever its status was
not `succeeded`, so a `requires_action` intent surfaced as a bare 402 decline —
no `intentId`, no `clientSecret` — and the browser had nothing to hand
Stripe.js: **the 3DS challenge could never be completed with real Stripe** (the
sandbox driver carried its intent data through; the real one dropped it, which
is what GO-LIVE-DELTA's old "3DS follow-up (not yet coded)" warning tracked).

Fixed in `stripe-provider.ts`: `requires_action` is now a first-class
`ChargeOutcome` preserving `intent.id` + `intent.client_secret`; the `/charge`
route answers `requiresAction: true` with a complete
`authentication: {provider, intentId, clientSecret, returnUrl}`; `lib/orders.ts`
passes it through to the `ChallengeDialog`, which runs
`stripe.handleNextAction(clientSecret)` and then `/confirm` re-reads the intent
from Stripe (never the browser's word). The route-level proof (sandbox driver)
is `apps/api/test/payments-seam.integration.test.ts`.
