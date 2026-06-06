# Decision Log

Append-only. Newest at the bottom. Each entry: what we decided, why, and any
consequences. If a decision is reversed, add a new entry that supersedes the old one
(don't delete history).

Format: `D-NNN — Title (date) — Status`

---

## D-001 — Build a sellable multi-tenant platform from day one (2026-06-04) — Accepted

We will **not** build a single-tenant tool for our own marina first and retrofit
multi-tenancy later. The platform is multi-tenant SaaS from the first commit.

**Why:** The owner's goal is to sell to outside operators immediately, including
operators more complex than our marina. Retrofitting tenant isolation onto a
single-tenant codebase is the classic SaaS rewrite trap. Designing it in once is
cheaper than rebuilding.

**Consequence:** Higher bar before anything is "done," but no architectural rework.
Every table and query is tenant-scoped from the start (see ARCHITECTURE § 1).

## D-002 — Architect for complex customers, not just our marina (2026-06-04) — Accepted

Target growth customers were identified as: (1) multi-location chains, (2) many
activity verticals beyond boats, (3) large staff with granular RBAC, (4) channel &
integration needs. All four are designed for now.

**Why:** These shape the core data model. Adding `Location`, generic `Activity`
categories + config JSON, an RBAC model, and a per-operator `Integration` config now
avoids painful migrations once a real chain signs up.

**Consequence:** Data model includes Location, Role/Permission, Resource, and
Integration entities beyond the original PRD baseline.

## D-003 — Stack confirmed (2026-06-04) — Accepted

Turborepo + pnpm · Next.js 14 (web + admin) · Node + Hono (API) · PostgreSQL +
Prisma · Square (payments) · Clerk + magic link (auth) · Resend (email) · Twilio
(SMS, later) · Cloudflare R2 · Vercel + Railway (deploy).

**Why:** Matches the PRD, is well-supported, and is fast to vibe-code. Node+Hono
chosen over Bun initially for stability on Windows/hosted runtimes; Bun remains an
option later.

## D-004 — Tenant isolation = operator_id + Postgres RLS + app-layer scoping (2026-06-04) — Accepted

Three-layer defense in depth (schema FK, database RLS, tenant-scoped data layer).
Tests must assert that cross-tenant access fails.

**Why:** Tenant data leakage is the #1 credibility killer for SaaS and involves real
customer PII (licenses, DOB, addresses). One layer is not enough.

## D-005 — Lean, incremental, budget-aware build (2026-06-04) — Accepted

Build in small vertical slices, mostly via direct work rather than large agent
swarms. The owner is on a limited plan; keep token/compute cost low. Repo docs are
the shared brain so agents don't re-discover context every session.

**Why:** Cost control + maintainability. A vibe-coded SaaS still has to be coherent
enough to harden and sell.

## D-006 — Dev infra: Neon Postgres + sandboxes, no Docker (2026-06-04) — Accepted

This machine has Node/npm/git but no pnpm and no Docker. Use corepack for pnpm and a
hosted free-tier Neon Postgres for the database instead of local containers. Redis
(Upstash) only when jobs/caching are actually needed. All external services run in
sandbox/free tier until go-live.

**Why:** Least friction for a hands-off owner; avoids installing/maintaining Docker;
keeps the owner out of the loop until production switches must be flipped.

## D-007 — Data access split: API for customer/integrations, direct DB for admin (2026-06-04) — Accepted

The Hono API (apps/api) owns the customer-facing booking/payment surface, POS, and
external integrations/webhooks. The admin app (apps/admin) uses server
components/actions that call `@marina/database` directly (tenant-scoped via
`forOperator(operatorId)` from the Clerk session → StaffMember). Both share business
rules through `@marina/core` (pricing, availability, validation) so logic is not
duplicated.

**Why:** Building the entire admin surface through an HTTP API client would roughly
double the work and integration surface. Direct, tenant-scoped DB access from
server-rendered admin is a standard Next pattern and keeps the build fast, while the
single source of truth for *rules* stays in @marina/core. Transactional writes that
both customer + staff perform (orders, payments, refunds) live in @marina/core
services callable from either side.

## D-008 — Shared packages: @marina/core, @marina/ui, @marina/emails (2026-06-04) — Accepted

`@marina/core` (pricing/tax/fee/tip math in integer cents, availability, order-number
generation, zod validation schemas, booking + refund services), `@marina/ui`
(white-label Tailwind component library), `@marina/emails` (React Email templates).
Stack additions: Square SDK v38 (SquareClient API), Resend, Clerk, recharts.

## D-009 — Relaxed noUncheckedIndexedAccess; .js→.ts webpack alias (2026-06-04) — Accepted

Dropped `noUncheckedIndexedAccess` from the base tsconfig (kept full `strict`). It
generated ~35 array-index false-positives across the agent-built code without
protecting the things that matter (money math, tenant scoping), which are covered by
tests and RLS. Also: shared `@marina/*` packages ship TS source with NodeNext `.js`
import specifiers; the Next apps add a webpack `resolve.extensionAlias` ('.js' →
['.ts','.tsx','.js']) so webpack resolves them. Square upgraded 38→44 (the version
that actually exports the `SquareClient` API the code was written against).

**Why:** Keep the large generated codebase building cleanly and honestly without
weakening real-correctness guarantees.

## D-010 — Tenant isolation: non-bypass app role; known FK-attach gap (2026-06-04) — Accepted

Two findings surfaced the first time the platform ran against a live Neon database,
both while bringing up the cross-tenant isolation suite (roadmap 0.8):

1. **Neon's `neondb_owner` has `BYPASSRLS`.** Using it for tenant queries silently
   defeated RLS (a tenant saw *all* rows). Fix: a dedicated **`app_user`** role that is
   `NOBYPASSRLS` and is **not** a table owner, provisioned idempotently by
   `pnpm db:approle` (packages/database/scripts/setup-app-role.ts). `forOperator` /
   `withTenant` now connect as `app_user` via `APP_DATABASE_URL`; `adminPrisma` keeps
   the owner connection for migrations/seed/genuine cross-tenant platform ops. This is
   the role half of D-004's defense in depth — RLS only bites a role that can't bypass
   it. The tenant client warns loudly if `APP_DATABASE_URL` is unset (dev fallback to
   owner = isolation NOT enforced). Also fixed: `apply-rls.ts` split the multi-statement
   .sql per-statement (Prisma's $executeRawUnsafe rejects multiple commands in one
   prepared statement, 42601) and runs DDL on the direct connection.

2. **Known gap — cross-tenant FK attach.** Postgres foreign-key checks are *not*
   subject to RLS, so a tenant can create one of its **own** rows that references
   another tenant's row by id (e.g. an A-owned `Rate` pointing at B's `activity_id`).
   Residual risk is low: the referencing row stays owned and readable only by the
   attacker, the referenced row remains invisible to them (RLS blocks the join), and
   the parent id is an unguessable cuid. But it is a real integrity gap. The robust
   fix is **tenant-composite foreign keys** — add `@@unique([operator_id, id])` to
   parents and make intra-tenant relations reference `[operator_id, parent_id]`, so the
   DB refuses a child whose parent lives in another tenant. Tracked as a Phase-0
   hardening item (ROADMAP 0.13). Until it lands, the corresponding isolation assertion
   is `it.skip`-ped with a pointer here, and app-layer create paths should validate
   parent ownership.

**Why:** Multi-tenant isolation is the product's core promise (AGENTS.md rule 2).
Getting the role model right makes RLS actually enforce; documenting the FK gap keeps
us honest about what RLS does and does not cover, with a concrete plan to close it.

## D-011 — Tenant-composite foreign keys close the FK-attach gap (2026-06-04) — Accepted

Implemented the D-010(2) fix (ROADMAP 0.13). Migration `tenant_composite_fks`:

- Added `@@unique([operator_id, id])` to the parent tables that intra-tenant children
  point at: `Activity`, `Rate`, `Timeslot`, `Order`, `Customer`, `Waiver`.
- Rewrote the **required** intra-tenant relations to **composite FKs** `(operator_id,
  parent_id) -> parent(operator_id, id)`: `Rate.activity`, `Timeslot.activity`,
  `Order.customer`, `OrderItem.{order,activity,rate,timeslot}`, `Payment.order`,
  `Note.order`, `OrderEvent.order`, `WaiverSignature.waiver`. Postgres FK checks bypass
  RLS, but a child stamped `operator_id = A` referencing B's parent finds no `(A,
  parent_id)` row, so the insert now errors. The previously `it.skip`-ped isolation
  assertion is un-skipped and passes; the live suite is **8/8**.

**Two consequences worth knowing:**
1. **Prisma allows `operator_id` to be shared across multiple composite relations** on
   one model (e.g. `OrderItem`'s four), and on a **nested create** it *derives*
   `operator_id` from the parent — so `items: { create: { operator_id, ... } }` is now
   rejected; drop the explicit `operator_id` (the DB then guarantees the child shares
   the parent's tenant). Top-level creates still take `operator_id` as before. Only the
   booking service + the isolation test needed this edit; typecheck catches the rest.
2. **Residual (intentionally not converted this pass):** *optional/nullable* relations
   — `Fee.activity`, `WaiverSignature.{order_item,customer}`, `Activity.location`,
   `Resource.location` — plus the `StaffLocation` join (has no `operator_id`) and the
   implicit `ActivityResources` m2m. These are lower-risk (nullable refs / join rows the
   app creates) and left as single-column FKs; revisit if we ever expose them to
   tenant-controlled input. App-layer create paths should still validate parent
   ownership for these.

**Why:** closes the one known integrity hole in D-010 with a DB-enforced guarantee,
making cross-tenant attach impossible rather than merely unlikely — the product's core
isolation promise now holds at the schema level, not just via RLS + app discipline.

## D-012 — Clerk staff auth behind a single REQUIRE_CLERK_AUTH switch (2026-06-04) — Accepted

Wired real Clerk auth for operators/staff (ROADMAP 0.7), replacing the dev shims —
but gated so it can't lock the owner out before the Clerk dashboard is set up.

- **One switch, both apps:** `REQUIRE_CLERK_AUTH=true` (AND keys present) turns on real
  auth in the **admin app** (`middleware.ts` clerkMiddleware + `auth.protect()`, plus
  `/sign-in` and `/sign-up` catch-all routes) and the **API** (`requireStaff` verifies a
  Clerk session token from `Authorization: Bearer …` via `@clerk/backend`). Default/unset
  = the dev OWNER fallback (admin `lib/session`) and the `x-dev-staff-id` shim (API) stay
  active, so everything is usable with no login.
- **Why a flag instead of "keys present" (the old `lib/session` heuristic):** the owner's
  `sk_test_…` key now lives in `.env`, so a keys-present check would have silently flipped
  admin into requiring a login that can't succeed until the Clerk dashboard has sign-in
  URLs + a staff user. The flag decouples "keys exist" from "enforce", matching the
  graceful-degradation posture used elsewhere (D-007 admin, marina-admin deploy notice).
- **Middleware is conditional:** no publishable key → passthrough (so a keyless deploy,
  e.g. the current marina-admin, doesn't crash); keys present → clerkMiddleware always
  runs so `auth()` has context, but only `protect()`s when the flag is on.
- **API enforcement is production-safe:** when enforced, ONLY a verified bearer token is
  accepted — the `x-dev-staff-id` header shim is disabled, so it can't be used to
  impersonate staff in production.

**To go live:** configure the Clerk dashboard (sign-in URLs `/sign-in` `/sign-up`, allowed
origins), create your staff user with `auth_user_id` matching its Clerk id (or invite via
the staff UI), then set `REQUIRE_CLERK_AUTH=true` on the admin (Vercel) + API (Railway)
envs. **Still pending for 0.7:** magic-link/OTP auth for *customers* on the web app
(today an order-number + email stub).

**Why:** real staff auth is required to sell, but flipping it on is a one-way door for
usability until external setup is done — so build it fully, verify it, and ship it dark
behind a switch the owner flips when ready.

## D-013 — Payments: switch from Square to Stripe (2026-06-04) — Accepted

Owner preference: use **Stripe** as the card processor instead of Square. The schema
already had `PaymentProcessor { SQUARE STRIPE }`, so this is a service/route/frontend
swap, not a data-model change.

- **Backend:** removed `services/square.ts` + the `square` dep; added `services/stripe.ts`
  (Stripe SDK, PaymentIntents) exposing the same shape the routes already used
  (`isStripeConfigured`, `StripeNotConfiguredError`/`StripePaymentError`, `createPayment`,
  `refundPayment`, plus `constructWebhookEvent`). `routes/payments.ts` is otherwise
  unchanged — it still records `Payment`/`Order`/`OrderEvent` in one tenant tx and now
  stamps `processor: 'STRIPE'`. `routes/webhooks.ts` rewritten for Stripe
  (`POST /webhooks/stripe`, `stripe.webhooks.constructEvent`, handles `charge.refunded` +
  `payment_intent.succeeded|payment_failed`).
- **Charge model:** the browser collects a card with Stripe Elements (`CardElement`) and
  makes a **PaymentMethod**; its id is sent to the API as `sourceId` (the wire field name
  was kept generic to minimise churn). The API creates + confirms a PaymentIntent in one
  synchronous call. Anything other than `succeeded` (incl. `requires_action` / 3-D Secure)
  is treated as a decline for now — **full SCA/3DS handling is a follow-up.**
- **Frontend:** `square-config.ts`→`stripe-config.ts` (publishable key only);
  `PaymentSection.tsx` rewritten with `@stripe/react-stripe-js` (`<Elements>` + hooks),
  same `tokenize()` imperative handle so `CheckoutClient` barely changed. Admin
  integration catalog: Square entry removed, Stripe is the sole card processor (+ webhook
  signing secret field).
- **Schema/migration:** `Payment.processor` default `SQUARE`→`STRIPE`
  (`20260605120000_payment_processor_default_stripe`, applied live).
- **Env:** `SQUARE_*` replaced by `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. Payments stay an opt-in integration: unconfigured
  = clean 501 (API) / "not configured" notice (checkout), same posture as before.

This supersedes the Square choice recorded in D-002/D-005. Verified: typecheck 9/9,
build 3/3, all 90 tests green (no test charges a card — live charge still needs keys).

**Why:** owner's processor of choice; Stripe's PaymentIntents + Elements are a clean fit
and the schema already anticipated it, so the switch is low-risk and self-contained.

## D-014 — Gift cards: ledgered stored value, overspend-safe redemption (2026-06-05) — Accepted

Built the gift-cards backend slice (ROADMAP 2.2) backend-first, same pattern as the
reschedule slice (new model → migration → service → endpoints → live integration test).

- **Data model — balance + signed ledger.** A `GiftCard` carries the authoritative
  `balance_cents` (integer cents, like all money here), and every change appends a
  `GiftCardTransaction` row. Amounts are **signed** (`+` for ISSUE/REFUND, `−` for REDEEM),
  so the ledger sums to the current balance — a built-in audit trail and reconciliation
  check for a money instrument. `balance_after_cents` records the running balance per
  entry. The transaction references its card via a **tenant-composite FK**
  `(operator_id, gift_card_id) -> GiftCard(operator_id, id)` (D-011), so a transaction can
  never attach to another tenant's card; `order_id` is a bare nullable reference (no FK),
  matching the D-011 residual posture for optional relations.
- **Redemption is overspend-safe by construction.** `redeemGiftCard` does not trust a
  read-then-write: after validating, it decrements with a **conditional** `updateMany`
  guarded on `is_active = true AND balance_cents >= amount`. If two redemptions race, only
  one matches a row; the other sees `count = 0` and is refused. Expiry is enforced, and the
  amount is re-validated server-side (never taken as pre-checked). Runs inside `withTenant`
  so RLS scopes the writes and the balance change + ledger entry are atomic.
- **Codes.** `generateGiftCardCode` (added to `@marina/core`) makes a grouped,
  hard-to-mistype code (`ABCD-EFGH-JKMN`) from an unambiguous alphabet (no 0/O/1/I/L), with
  randomness from cuid2's CSPRNG; uniqueness is still DB-enforced
  (`@@unique([operator_id, code])`) and the issuer retries on the rare collision.
- **Surface + authz.** Staff (gated): `POST /giftcards` issue (`order:write`),
  `GET /giftcards` list (`order:read`), `POST /giftcards/:code/redeem` (`order:write`).
  Public: `GET /giftcards/:code/balance` — the full code is the bearer secret, so a
  balance check by code needs no auth (you must already hold it). Issuing/redeeming are
  staff actions for now.
- **Scope boundary (deliberate follow-ups).** This slice is staff/POS issuance + redemption
  only. **Customer-checkout redemption** (applying a gift card as tender during a booking)
  is intentionally deferred because it belongs with the payment flow (which is blocked on
  Stripe keys) — the `PaymentMethod.GIFT_CARD` enum already exists for it. A **public
  purchase** flow (a customer buying a gift card) likewise needs Stripe. An **admin UI** is
  also a follow-up. The `REFUND`/`ADJUST` ledger types are modeled but not yet wired to
  endpoints (they exist so cancelling a gift-card-paid booking can credit the card later).

Migration `20260605130000_gift_cards` applied live to Neon (additive, zero drift); both
tables added to `rls.sql` and `db:rls`/`db:approle` re-run so RLS policies + the non-bypass
`app_user` grants cover them. Verified: typecheck 9/9, build 3/3, **101 tests green** (core
69 + isolation 8 + api 24, incl. a new 6/6 live gift-card suite).

**Why:** gift cards are stored value — real money sitting on the platform — so the
guarantees that matter are (1) the balance is always reconcilable (signed ledger) and
(2) it can never be overspent (DB-arbitrated conditional decrement, not an app-level race).
Both are enforced at the data layer, consistent with the product's rock-solid-over-money
posture (AGENTS.md rule 3).

## D-015 — Gift card as tender = a GIFT_CARD Payment + ledgered draw-down, one tx (2026-06-05) — Accepted

Built on D-014: a gift card can now pay down an order's balance (ROADMAP 2.3). The
operation that ties the two money instruments together — `applyGiftCardToOrder` — runs in
a **single tenant transaction** so the card balance, the gift-card ledger, the `Payment`
row, and the order's `amount_paid_cents`/`balance_due_cents` can never drift:

- **One atomic tx, no nested service calls.** It does NOT call `redeemGiftCard` (which opens
  its own `withTenant` tx — nesting two transactions); instead it replicates the same
  overspend-safe guarded decrement (`updateMany WHERE is_active AND balance >= amount`)
  inline, then in the same tx writes a signed `REDEEM` `GiftCardTransaction` **stamped with
  the order id** (so the ledger entry and the Payment cross-reference each other), a
  `Payment{ method: GIFT_CARD, status: PAID }` whose `processor_transaction_id` points at
  that ledger entry, advances the order, and logs a `PAYMENT` OrderEvent.
- **Amount semantics.** Applies `min(requested | card balance | balance due)`. With no
  amount it applies as much as covers the balance (the common "settle this with the card"
  case). Over-balance-due (`EXCEEDS_BALANCE_DUE` 400), over-card-balance
  (`INSUFFICIENT_BALANCE` 409), and already-settled (`NOTHING_DUE` 400) are all refused.
- **Processor field.** `Payment.processor` is a non-null `{SQUARE|STRIPE}` enum with no
  stored-value member, so a gift-card Payment keeps the schema default; the meaningful link
  is `processor_transaction_id = <GiftCardTransaction id>`. (Changing the enum to add a
  GIFT_CARD/CASH/COMP processor was considered and deferred — it'd touch the migration +
  Stripe/POS code for no functional gain right now; revisit if reporting needs to filter by
  tender type at the Payment level rather than by `method`.)
- **No Stripe dependency.** This is stored value, so the endpoint (`POST /api/payments/gift-card`)
  works with payments unconfigured — unlike `/charge` and `/refund`, it has no
  `isStripeConfigured()` gate.
- **Surface.** Staff-gated (`order:write`) — the staff/POS "pay with gift card" action.
  **Customer-checkout gift-card tender** (a guest paying with a gift card during online
  checkout) remains the follow-up; it belongs with customer magic-link auth (0.7), since the
  customer flow needs an identity to attach the action to.

Verified: typecheck 9/9, build unaffected, **193 tests green** (core 69 + isolation 8 + api
116, incl. a new 5/5 live tender suite — partial apply, default-settle-to-zero, over-due
refusal, already-settled refusal, 401-without-staff).

**Why:** recording gift-card spend as a real `Payment` (not a magic order adjustment) keeps
the order's money story uniform across tender types — card, cash, comp, gift card all land
as `Payment` rows that sum to `amount_paid_cents` — while the single-tx draw-down preserves
the D-014 guarantees (reconcilable ledger, no overspend) across the order boundary.

## D-016 — Gift-card payment refund: polymorphic refund endpoint, card credit (2026-06-05) — Accepted

Completes the stored-value loop opened by D-014/D-015 (issue → tender → **refund**). When a
gift-card-paid order is cancelled or adjusted, the tender must go back onto the card.

- **One refund endpoint, branched by tender.** `POST /api/payments/:id/refund` now loads the
  Payment first and branches on `method`: a `GIFT_CARD` payment routes to
  `refundGiftCardPayment` (credits the card, no Stripe); anything else keeps the existing
  Stripe path. This keeps a single staff refund action (`order:refund`) regardless of how the
  order was paid, and means gift-card refunds work even with payments unconfigured.
- **Reverse of the tender, same atomicity.** `refundGiftCardPayment` runs in one tenant tx:
  resolves the originating card via the Payment's linked ledger entry
  (`processor_transaction_id` → the REDEEM `GiftCardTransaction` → `gift_card_id`), increments
  the card balance, appends a **positive** `REFUND` ledger entry (stamped with the order id),
  advances the Payment's `refunded_cents`/`status` (PARTIAL_REFUND vs REFUNDED), rolls the
  order's amount_paid/balance_due back, and logs an OrderEvent. Supports partial refunds and
  refuses over-refunding (`EXCEEDS_REFUNDABLE`) or double refunds (`ALREADY_REFUNDED`).
- **Linking choice.** The card is found through the Payment→ledger link rather than a direct
  `Payment.gift_card_id` column — no schema change, and the REDEEM/REFUND entries already form
  the audit chain. (If gift-card analytics ever need to query payments by card directly, add a
  nullable `gift_card_id` then; not worth a migration now.)
- **Auto-refund-on-cancel deferred.** Cancelling an order still does NOT auto-refund its
  payments (card or gift card) — refunds stay an explicit staff action, matching the card
  model and avoiding surprise auto-credits where an operator may charge a cancellation fee.
  Auto-credit-to-gift-card on cancel can be layered on later as an operator policy.

Verified: typecheck 9/9, **194 tests green** (core 69 + isolation 8 + api 117, incl. a live
gift-card refund case — full refund credits the card + rolls the order back + positive REFUND
ledger entry + double-refund refused).

**Why:** an operator must be able to make a gift-card customer whole, and stored value should
return to where it came from. Branching the existing refund endpoint (rather than a separate
one) keeps the staff mental model uniform, while the single-tx reverse mirrors D-015 so the
ledger stays reconcilable in both directions.

## D-017 — Customer auth: passwordless email-OTP + stateless HS256 token (2026-06-05) — Accepted

The remaining 0.7 gap was customer (guest) auth — needed for customer self-service and
customer-checkout gift-card tender. Chose **email OTP** over magic-link or reusing Clerk.

- **Why email OTP (not magic-link / not Clerk):** OTP is the simplest to build and verify
  headlessly, reuses the existing Resend wiring, and needs no landing-page round-trip or
  Clerk-dashboard setup (which is blocked-on-owner). Magic-link is a later UX upgrade; Clerk
  stays staff-only (the guest flow wants a lightweight, self-service identity, not a managed
  user record per booker).
- **Mechanism:** `CustomerOtp` stores only `sha256(code)` (never the raw code), a 10-minute
  expiry, and an attempt counter; a new request invalidates a tenant's prior unconsumed codes.
  `verifyLoginCode` is single-use (consumes on success) and capped at 5 attempts. On success
  it mints a **stateless HS256 JWT** (`hono/jwt`, no new dep) carrying `{ operatorId, email,
  customerId }`, mirroring the staff Clerk-bearer model — verified per request, scoped to the
  resolved operator. No server-side session table to manage.
- **Secret + graceful degradation:** the token secret is `CUSTOMER_AUTH_SECRET` — REQUIRED in
  production (fails closed) with a clearly-insecure dev fallback so local/test stays runnable.
  When email isn't actually delivered (no Resend key, or a send failure) AND we're not in
  production, `requestLoginCode` returns the code in the response (`devCode`) so the flow is
  completable headlessly — the same posture as D-012 (Clerk) / D-013 (Stripe). Never exposed
  once email truly sends or in production.
- **Integration:** self-reschedule now derives identity from a verified token first, falling
  back to the email-in-body stub (kept for backward compat); a token's email can't be spoofed,
  and body email became optional. This is the template for token-gating future customer
  endpoints (customer-checkout gift-card tender next).
- **Transaction correctness (bug found + fixed):** the wrong-code attempt increment originally
  shared the same `withTenant` transaction as the rejection `throw` — which rolled the
  increment back, so the brute-force cap never actually counted. Fixed by committing the
  increment in its own transaction before throwing. General lesson recorded: a side effect
  that must survive a rejection cannot live in the transaction we abort by throwing.

Verified: typecheck 9/9, build 3/3, **199 tests green** (core 69 + isolation 8 + api 122),
incl. a 5/5 live OTP suite. Migration `20260605140000_customer_otp` applied live; `CustomerOtp`
added to RLS + app_user grants.

**Why:** customer auth is the foundation under self-service and customer-paid gift cards;
email-OTP + a stateless signed token is the least-moving-parts design that's secure (hashed,
single-use, rate-capped, fail-closed secret) and testable without owner-provisioned accounts.

## D-018 — Gift-card management: ADJUST corrections + reversible void (2026-06-05) — Accepted

Wired the last modeled-but-unused gift-card ledger type (`ADJUST`, from D-014) and added
the staff freeze controls, finishing gift-card *management* (issue → tender → refund → now
correct/void). No schema change — the enum and `is_active` column already existed; this is a
pure service + route + live-test slice.

- **Manual balance correction = a signed `ADJUST` entry.** `adjustGiftCardBalance(code,
  deltaCents, reason)` applies a signed delta and appends an `ADJUST` ledger row, so the
  invariant "the ledger sums to `balance_cents`" still holds. A reason is **required** (it's a
  money correction — the audit trail must say why). A **negative** delta uses the same
  overspend-safe conditional `updateMany` guard as `redeemGiftCard`, so a correction can never
  drive the balance below zero (`ADJUST_BELOW_ZERO`) or race a concurrent draw-down.
- **Void = a reversible freeze, not value destruction.** `voidGiftCard` flips `is_active` to
  false (both redeem and tender already guard on it, so a voided card is unspendable) but
  **preserves the balance** — no stored value silently disappears, and `reactivateGiftCard`
  restores spendability. Each writes a **zero-amount `ADJUST` marker** entry (`amount_cents:
  0`, note "Voided: …" / "Reactivated: …") for the audit trail; a zero entry leaves the ledger
  sum unchanged, so the invariant is preserved. Considered void-and-zero (drain the balance to
  0) and rejected it: freezing is reversible and doesn't destroy money an operator may still
  owe the holder. Idempotency guards: re-void → `ALREADY_VOIDED`, re-activate → `ALREADY_ACTIVE`
  (both 409). Adjusting a voided card is refused (`GIFT_CARD_INACTIVE`) — reactivate first.
- **Gated at `order:refund`, not `order:write`.** Rewriting stored value is a money-correction
  action on par with issuing a refund, so the three endpoints (`POST /giftcards/:code/adjust`
  · `/void` · `/reactivate`) require `order:refund` (MANAGER+), above the `order:write` tier
  that plain order STAFF hold for redeem/tender. Verified live: a STAFF-role identity gets 403.

Verified: typecheck 9/9, **api +10 live cases** (adjust up/down + signed entries, below-zero
refused, empty-reason refused, HTTP adjust 200 + 403-for-STAFF + 401-no-identity, void freezes
+ blocks redeem/adjust + double-void, reactivate + double-reactivate + re-spend; ledger-sum
invariant asserted throughout). Held locally, not pushed (Vercel quota).

**Why:** gift cards are real money on the platform, and an operator must be able to fix a
mistake (mis-issued amount, goodwill credit) and kill a lost/fraudulent card — without ever
breaking the two D-014 guarantees (reconcilable signed ledger, no overspend) or destroying
value that can't be recovered. Reversible-freeze + signed-correction keeps both true.

## D-019 — Reminders via an idempotent cron-triggered sweep, not a job runner (2026-06-05) — Accepted

Finished the 1.7 follow-ups: the pre-arrival reminder email needed a *scheduler*, and the
POS sale needed to fire a confirmation. The notification send-paths already existed (D-013
wiring); the open question was how to schedule reminders without standing job infra.

- **No job runner — an idempotent HTTP sweep an external cron pings.** ARCHITECTURE § 4 defers
  Redis/BullMQ until actually needed; a once-a-day reminder doesn't justify it. Instead
  `sendDueReminders` (services/reminders.ts) finds every UPCOMING booking whose timeslot starts
  within a look-ahead window (`leadHours`, default 24) and hasn't been reminded, sends each, and
  is exposed at **`POST /jobs/reminders`** for any scheduler (Vercel Cron / Railway cron / a
  pinger) to hit on a cadence. The scheduler is the only moving part we don't own, and it's
  trivially swappable.
- **Idempotency via a dedicated `Order.reminder_sent_at` stamp.** Chose a real nullable column
  (migration `20260605150000_order_reminder_sent_at`, additive — no RLS/grant change, table
  already covered) over scanning OrderEvents: it's directly filterable in the WHERE
  (`reminder_sent_at: null`), so a reminded booking is never re-selected. A booking is stamped
  once a reminder has been **dispatched to the provider** (delivered OR provider-error), not only
  on confirmed delivery — so a flaky provider tick can't make the cron re-send the same booking
  every beat (no retry-storm). It's left unstamped (retried next run) only when email is entirely
  unconfigured or the order became ineligible mid-run. Best-effort delivery; a `reminder_attempts`
  retry counter is a future refinement if needed.
- **Tenant discipline preserved.** The sweep loops operators and does every per-tenant read/write
  through the RLS-scoped `forOperator` client; only the operator *list* uses `adminPrisma` (the
  one audited platform-admin path, ARCHITECTURE § 1). It can also be scoped to one operator.
- **Job auth = a shared secret, fail-closed in prod.** `/jobs` is platform-level (iterates
  operators), so like `/webhooks` it's mounted OUTSIDE the tenant middleware and authed by
  `JOBS_SECRET` (sent as `Authorization: Bearer …` — Vercel Cron's convention — or `x-jobs-secret`),
  not a staff session. With no secret set it's open in non-production and refuses in production,
  mirroring D-017's secret posture. The check reads env per request (testable, config-reloadable).
- **POS-sale confirmation.** `POST /api/pos/sale` now fires `sendBookingConfirmation`
  (fire-and-forget, `isEmailConfigured()`-guarded) — but only for a real customer email (the
  synthetic `@pos.local` walk-in addresses are excluded, here and in the reminder selection) on a
  sale that actually booked something. Deliberately NOT the staff-new-booking alert: a POS sale is
  made *by* staff at the counter, so alerting them to their own sale is noise.

Verified: typecheck 9/9, **api +N live cases** (in-window booking stamped; far-future + CANCELLED
left untouched; idempotent re-run; HTTP open-in-dev + JOBS_SECRET-enforced 401/200). Migration
applied live to Neon. Held locally, not pushed (Vercel quota).

**Why:** reminders are a real retention feature but low-frequency, so the right cost is an
idempotent endpoint + an external cron, not standing queue infrastructure. A DB stamp makes
"exactly once" a query invariant rather than app bookkeeping, and the secret-gated platform
endpoint keeps the trigger off the tenant surface while staying safe by default.

## D-020 — Multi-location roll-up reporting; item-level location attribution (2026-06-05) — Accepted

Multi-location chains are the #1 target growth customer and the reason the whole platform is
architected as it is (D-001/D-002); Phase 3 lists "multi-location dashboards + roll-up
reporting". Started it backend-first by extending the existing reports route (D-2.4 pattern):
`GET /api/reports/by-location` (+ `.csv`), report:read-gated, date-range filtered.

- **Attribute at the *item* level, not the order level.** An order can span locations (items
  for activities at different sites), and the order's money fields (total/tax/tip/discount/
  refund) aren't split per item — so attributing order totals to a single location would be a
  lie. Instead the roll-up sums **booking line items** to their activity's location, with gross
  = `unit_price_cents * quantity` (the one money figure unambiguously tied to one location).
  Counts (`bookingCount`, `totalQuantity`) and gross per location, plus a chain-wide roll-up
  total whose figures equal the sum of the location rows by construction (a tested invariant).
- **Scope boundary (deliberate).** This reports per-location *gross booking value* + volume, not
  a full per-location P&L — order-level tax/tip/fees/refunds stay on `/revenue` (operator-wide),
  because splitting them per location needs an allocation policy we haven't decided. Activities
  with no location land under an `unassigned` row. CANCELLED orders are excluded, matching
  `/revenue`. A future slice can add per-location net once an allocation rule is chosen, and
  filter the other reports by `?locationId=`.
- **No schema change.** Location already sits between Operator and Activity (ARCHITECTURE § 3);
  this is pure read-side aggregation over `OrderItem → Activity → Location`, RLS-scoped via
  `c.var.db` like the rest of reports.

Verified: typecheck 9/9, **api +3 live cases** (two fresh locations each with their own
activity/rate/slot/booking → exact per-location gross/qty, row-sum == roll-up total invariant,
report:read 401-without-staff, CSV carries the TOTAL row). Held locally, not pushed (Vercel quota).

**Why:** the multi-location promise has to show up where an operator feels it — "how is each
site doing" — and the honest, unambiguous version of that is item-level attribution. Building it
on the existing reports route keeps it a small, consistent slice while realizing a core
differentiator at the data layer.

## D-021 — Accounting export = a payment-level journal keyed by cash date (2026-06-05) — Accepted

Phase 3 lists accounting exports (QuickBooks/Xero). A real business won't buy software it can't
reconcile against its books, so added a transactions export: `GET /api/reports/transactions`
(+ `.csv`), report:read-gated, date-range filtered — extending the reports route (D-2.4 pattern,
no schema change, no external account needed for a downloadable file).

- **One row per Payment, net of its own refunds.** The schema has no standalone refund-transaction
  entity — a refund advances `refunded_cents` on the originating Payment (D-016) — so the faithful
  representation is one journal row per payment carrying `gross`, `refunded`, and `net = gross −
  refunded`, plus method/processor/processor_transaction_id/order#/customer/manually-keyed. This is
  the universal shape a bookkeeper maps into QuickBooks/Xero.
- **Keyed by `processed_at` (cash-movement date), not order creation.** Unlike `/revenue` and
  `/bookings` (which key by `Order.created_at`), the accounting journal keys by when money actually
  moved — that's what reconciles to a bank statement. A deliberate, documented difference.
- **Per-tender reconciliation breakdown + totals.** Groups by `method` (CARD/CASH/GIFT_CARD/COMP)
  with count/gross/refunded/net, and a grand total — so an operator can tie the export's card line
  to the Stripe payout and the cash line to the till. Row sums equal the totals by construction
  (a tested invariant).
- **Scope (deliberate).** This is a flat transaction journal, not double-entry journal entries with
  GL account mapping — that mapping is operator-specific and belongs in a later integration slice.
  The CSV is the lowest-common-denominator import that every accounting package accepts. Direct
  QuickBooks/Xero API sync (OAuth, account mapping) is a future Phase-3 item gated on those accounts.

Verified: typecheck 9/9, **api +3 live cases** (a partially-refunded CARD + a CASH payment on one
order → exact per-row net, row-sum == per-method-sum == totals invariant, report:read
401-without-staff, CSV carries the TOTAL line). Held locally, not pushed (Vercel quota).

**Why:** "can I get my money into my accountant's system" is table stakes for selling to a real
operator. A payment-level journal keyed by cash date, with a tender reconciliation, is the honest
minimum that's immediately useful and import-ready — without committing to a GL-mapping model
before we know each customer's chart of accounts.

## D-022 — Waiver templates are versioned + immutable; "edit" = publish a new version (2026-06-05) — Accepted

"Waivers are legally sound — captured signatures, minor handling, audit trail" is a go-live
requirement (CONTEXT § rock solid). Waiver templates were seed-only with no management API; added
staff management — but designed around audit integrity rather than naive CRUD.

- **`template_html` is immutable once it exists.** Every `WaiverSignature` references the exact
  `Waiver` row (version) the customer signed. Editing a template in place would silently rewrite
  the legal text that signed history points at — a tamper of the audit trail. So there is **no
  PATCH of template content**: "editing" is `POST /waivers/templates`, which creates a NEW Waiver
  row. Old versions are retained forever for the signatures that reference them; the list endpoint
  surfaces each version's `signatureCount` so a version with signed history is visibly permanent.
- **Exactly one active version, switched transactionally.** Signing resolves the active template.
  `POST /templates` with `activate` (default true) deactivates the prior active version in the same
  transaction; `POST /templates/:id/activate` flips a chosen version active and all others inactive
  atomically. `activate:false` stores an inactive draft without disturbing the live one. This makes
  "what are customers signing right now" a single unambiguous row, while version switches never
  touch past signatures.
- **Gated at `operator:manage`; listing at `order:read`.** The waiver is operator-level legal
  config (alongside branding / danger-zone), so publishing/activating requires `operator:manage`
  (OWNER tier) — verified live that a MANAGER (who has `order:write` but not `operator:manage`)
  gets 403. Reading the versions is `order:read` so front-desk staff can see them. A dedicated
  `waiver:manage` permission (to let ADMIN manage waivers without full `operator:manage`) is a
  clean future refinement; reused the existing config-tier perm to keep this slice off the
  permission-model surface.

Verified: typecheck 9/9, **api +5 live cases** (lists the seed active version; publish-new-active
deactivates the prior + public /active follows; inactive-draft leaves the active untouched;
activate switches; 401-anon + 403-for-MANAGER). The test restores the seed's original active
waiver in teardown. Held locally, not pushed (Vercel quota).

**Why:** a waiver is a legal record — its history must be tamper-evident. Modeling "edit" as an
append-only new version (never an in-place mutation) makes that a structural guarantee, not a
discipline, while a single transactionally-switched active version keeps the signing path simple.

## D-023 — Resource/asset management: catalog + activity assignment (capacity-backing deferred) (2026-06-05) — Accepted

Started the Phase-3 "resource/asset management" pillar (the moat for complex operators —
multi-asset inventory: boats, jet skis, kayaks, patios). The `Resource` model + the
`ActivityResources` m2m have existed since Phase 0 (ARCHITECTURE § 3) but had no API. Added staff
CRUD + the activity assignment: `GET/GET:id/POST/PATCH/DELETE /api/resources`.

- **Catalog now; capacity-backing later (deliberate).** This slice manages the asset records
  (name, `seat_capacity`, `quantity`, `out_of_service_qty`, `enable_timer`, location) and *which
  activities each backs* (the m2m). It does NOT yet make availability/capacity derive from
  resources — today capacity lives on `Timeslot.capacity_total`. Resource-backed availability (a
  boat can only be in one place at once → it constrains every activity that uses it) is the high-
  value follow-up; cataloguing + assignment is the necessary foundation and is useful standalone
  (operators can inventory assets and tag usage). `availableQty = quantity − out_of_service_qty` is
  surfaced as the derived in-service count that capacity will later draw on.
- **Permissions = the activity tier.** A resource is part of the bookable-catalog configuration, so
  reads require `activity:read` and writes `activity:write` (MANAGER+), consistent with activities/
  merchandise. Verified live a GUIDE (activity:read only) gets 403 on write.
- **Tenant-safe references + invariants.** `locationId`/`activityIds` are pre-validated against the
  RLS client (a cross-tenant id is invisible → clean 400 rather than a Prisma connect error), and
  `out_of_service_qty > quantity` is refused (checked against the merged state on PATCH). PATCH
  *replaces* the activity set (`set`), POST connects. Soft-delete (deactivate) by default to
  preserve assignments; `?hard=true` removes the row (m2m join rows cascade; activities untouched).
- **No schema/RLS change.** `Resource` was already in `rls.sql` and the `app_user` grants are
  table-wide, so this is a pure code slice.

Verified: typecheck 9/9, **api +7 live cases** (create+assign+derived availableQty, list+count+
search, detail, patch-replaces-set + oos>qty 400, unknown activity/location 400, soft-then-hard
delete, 401-anon + 403-GUIDE). Held locally, not pushed (Vercel quota).

**Why:** complex multi-asset operators are an explicit target (D-002), and asset inventory is the
substrate real capacity management is built on. Shipping the catalog + assignment first — with the
derived in-service count already exposed — lets the resource-backed-availability follow-up be a
focused capacity change rather than a model-and-API change at once.

## D-024 — Resource-backed availability: shared assets constrain capacity across activities (2026-06-05) — Accepted

Delivered the D-023 follow-up — the actual moat. A `Resource` is now a finite, SHARED pool: an asset
backing more than one activity (the `ActivityResources` m2m) can only be in one place at one time, so
booking it for one activity removes that capacity from every sibling activity for the OVERLAPPING
time. New service `services/resource-availability.ts` is the single primitive both the write-guard and
the read overlay call.

- **Seat-pool model, using the fields already on `Resource`.** A resource provides
  `poolTotal = seat_capacity × (quantity − out_of_service_qty)` seats at any instant; a booking of N
  participants draws N seats. An activity backed by several resources is bound by the scarcest (min
  remaining). An activity backed by NO active resource returns `remaining: null` — unconstrained,
  identical to the pre-existing per-timeslot behaviour (zero behaviour change for non-resource
  operators, which is most of the seed today).
- **Duration comes from the Rate, not the Activity (corrected mid-build).** `duration_minutes` lives
  on `Rate` (a "2-hour rental" and a "4-hour rental" are two rates on one activity), NOT on `Activity`
  (which has no duration field). So a booking occupies `[slot.datetime, slot.datetime + rate.duration)`
  and contention is measured at the **OrderItem** level — each item carries its own start (timeslot)
  and its own duration (rate). Aggregated `Timeslot.capacity_booked` is insufficient: one slot can hold
  mixed-duration bookings. Overlap is the standard half-open test (`a < d ∧ b > c`).
- **Two call sites, one primitive.** (1) Booking write-guard (`createBooking`): after the per-slot
  capacity check, refuse with `INSUFFICIENT_RESOURCE_CAPACITY` (409) when the pool can't fit the
  quantity — authoritative, using the chosen rate's exact duration. (2) Customer day-availability read
  (`getDayAvailability`): a batched overlay that lowers each slot's `capacityRemaining` to the lesser of
  its own free seats and the pool's, flips a new `resourceConstrained` flag, and drives the traffic
  light off the EFFECTIVE remaining (a slot the asset has fully committed reads FULL though its own
  seats are open). The read is rate-agnostic, so it sizes the candidate window with the activity's
  LONGEST active rate (conservative — never understates contention).
- **Structural client typing.** The primitive accepts a hand-written `ResourceClient` interface
  (delegates typed `(args: any) => Promise<any>`, results re-pinned with local annotations) so BOTH a
  `Prisma.TransactionClient` (booking tx) and a `TenantClient` (availability read) satisfy it without
  fighting Prisma's extended-client generics.
- **No schema/RLS change.** Pure code over existing tables. (Side note: the generated Prisma client was
  stale — predated `Rate.duration_minutes` — and was regenerated; a build-time artifact, nothing to
  commit.)
- **Scoped deliberately.** Enforced on the primary `createBooking` money path + the customer read.
  **Follow-ups (documented, not yet done):** resource enforcement in `rescheduleBooking` and the POS
  sale path; whole-unit/exclusive-charter allocation as a per-resource policy (vs today's shared
  seating); and a resource overlay on the month-range availability rollup.

Verified: typecheck 9/9, **api +6 live cases** vs Neon (full pool when empty, unbacked → null, a
booking on A drains the OVERLAPPING B slot while a non-overlapping B slot stays full, booking-on-B
refused with the resource as the sole binding limit, day-availability shows `resourceConstrained` +
0 remaining + FULL, batched lookup keyed by slot id). Full api suite **156 → 162 green**; grand total
**233 → 239** (core 69 + isolation 8 + api 162). Held locally, not pushed (Vercel quota).

**Why:** shared multi-asset inventory is the differentiator legacy per-activity tools (Singenuity)
can't express — a boat double-booked across two activities is the exact failure operators fear.
Routing both the guard and the customer-facing read through one overlap-aware primitive makes the
constraint correct at the point of sale and honest in the catalog, while the `remaining: null`
short-circuit keeps it a no-op for operators who haven't modeled resources.

## D-025 — Bugfix: order-number sequence counted the wrong day → duplicate order numbers (2026-06-05) — Accepted

Found and fixed a real booking-path bug while testing D-024. The human `order_number` encodes the
**service date** (`<CODE><YYMMDD><SEQ3>`, from the booked slot's day), but `createBooking` computed
the sequence as `count(orders WHERE created_at ∈ the slot's calendar day) + 1`. For any FUTURE slot,
no orders were *created* on that future date, so the count was ~0 and every booking for a given future
service day got sequence `001` → the second booking for that day collided on the `order_number` unique
constraint and threw P2002. Multiple bookings for the same future date is the normal case, so this
broke booking #2 for any service day with more than one reservation.

- **Fix:** sequence now counts orders that already share the day's prefix
  (`order_number startsWith orderNumberPrefix(code, slotDate)`) — i.e. orders for that SERVICE date,
  which is exactly what the number's sequence is meant to count. Factored `orderNumberPrefix()` out of
  `generateOrderNumber()` in `@marina/core` so the two can't drift.
- **Concurrency:** two simultaneous bookings for the same day can still read the same count and race on
  the unique constraint. Wrapped `createBooking` in a bounded retry (≤3) that recomputes on a P2002
  naming `order_number` and re-runs the whole tenant transaction (atomic rollback → no partial writes
  between attempts). The unique index remains the final arbiter.
- **POS is unaffected** — it numbers by `now` and counts orders created today, which is self-consistent
  (creation-date numbering), so it was left as-is.

Verified: typecheck 9/9, core 69/69, **api +1 live case** (two bookings on one future service day get
distinct, strictly-increasing sequences sharing the prefix) + the full booking suite still green. api
**164 → 165**; grand total **241 → 242**. Held locally, not pushed (Vercel quota).

**Why:** order numbers are customer- and staff-facing primary references; silently colliding (and
500-ing the second booking) on the most common real pattern — several reservations for one day — is a
launch-blocker. Counting by the prefix the number already commits to makes the sequence correct by
construction, and the retry turns the residual race into a self-healing path rather than a 500.

## D-026 — Resource allocation mode: shared seating vs whole-unit charter (2026-06-05) — Accepted

Completed the resource pillar with the per-resource allocation policy the shared-seat-only model
(D-024) couldn't express — and which was an actual correctness gap. With only shared seating, a
2-person charter on a 10-seat boat consumed just 2 of the pool's seats, leaving the system willing to
sell that same boat to 8 more people for a *different* activity at the same time — i.e. double-booking
a chartered asset. Added a `ResourceAllocationMode` enum + `Resource.allocation_mode`
(migration `resource_allocation_mode`, additive column default `SHARED_SEATS`, applied live to Neon;
no RLS change — `Resource` is already covered).

- **SHARED_SEATS (default, unchanged):** pool = `seat_capacity × availableQty`; a booking of N draws N
  seats (kayak fleet, group-tour benches).
- **WHOLE_UNIT (new):** a booking reserves a whole unit regardless of party size; the pool is the unit
  count and each overlapping booking consumes one unit. A chartered boat is unavailable to everyone
  else for its window even if only 2 of 10 seats sold.
- **Uniform caller contract.** `getResourceConstraints` still returns `remaining` normalised to
  PARTICIPANTS, so the booking guard / POS / reschedule / availability reads compare it to a quantity
  exactly as before — only the per-resource math branches on the mode (whole-unit ⇒ remaining is the
  unit's `seat_capacity` when ≥1 unit is free, else 0). No call-site changes.
- **API surface.** `/api/resources` accepts + returns `allocationMode` (zod enum, default
  `SHARED_SEATS`); pure additive.

Verified: typecheck 9/9, **api +1 live case** (a 2-of-10-seat booking on a WHOLE_UNIT charter drives
remaining 0 and a second concurrent booking is refused `INSUFFICIENT_RESOURCE_CAPACITY`, where the
shared model would have left 8) + full suite green. api **166 → 167**; grand total **243 → 244**.
This closes the last D-024 follow-up — the resource pillar is now complete. Held locally, not pushed
(Vercel quota).

**Why:** charter / exclusive-use rentals are a first-class marina vertical (whole-boat, whole-patio),
and modeling them as shared seats silently permits double-booking the exact physical asset the feature
exists to protect. A one-column policy keeps the common shared-seat path the zero-config default while
making exclusive allocation a correct, explicit opt-in.

## D-027 — Founder cockpit docs at root; PRs staged locally vs Vercel quota (2026-06-06) — Accepted

Two operating decisions for the founder-driven build phase.

1. **Root-level founder docs complement the `docs/` brain.** Added `VISION.md`,
   `ROADMAP.md`, `TASKS.md`, `PROGRESS.md` at the repo root as the forward-looking
   founder cockpit. The detailed `docs/` set stays the source of truth for *why*
   (CONTEXT/ARCHITECTURE) and the append-only decision log; `docs/ROADMAP.md` stays
   the granular backend status board + changelog. Root `ROADMAP.md` is the
   phase-level plan, `TASKS.md` the active board, `PROGRESS.md` the running log.
   Rationale: a single glanceable cockpit for an owner, without disturbing the
   established deep docs.
2. **One clean PR per phase, staged locally, not pushed until the owner clears
   Vercel quota.** Phase work happens on a feature branch (`phase-1-cockpit`, …) so
   it is PR-ready, but pushing *any* branch triggers a Vercel deployment (preview or
   production) and the owner has flagged a quota crunch (memory: marina-vercel-quota).
   So commits accumulate cleanly on the branch and the PR is opened the moment the
   owner says push. This honors "clean PR per phase" without burning the resource the
   owner asked to protect.

**Why:** keep the owner's cockpit clean and the cost posture intact while still
working in disciplined, reviewable phase units.

## D-028 — Phase 1 = wire the cockpit (surface the backend before adding more) (2026-06-06) — Accepted

The next build phase is **surfacing existing backend capability in the UI**, not
adding new backend. The backend is production-grade and largely live-verified, but
a large share of it is unreachable from the apps: gift cards, resources/assets (the
moat), waiver-template management, multi-location roll-up + accounting reports, and
the customer email-OTP login all have working backends and **no UI**. The frontend
also builds but has never been exercised end-to-end.

**Decision:** before any new backend feature or the self-serve front door (Phase 2),
make every shipped capability reachable and usable from a working UI, and drive the
existing frontend to confirm it works.

**Why:** "built but unreachable" is not functional. The highest-leverage,
owner-valuable, no-owner-keys-required work is connecting the Ferrari engine to a
dashboard. It also makes the product demoable and de-risks everything downstream
(you can't sell or onboard onto features no one can see).

## D-029 — Admin management UIs call the live-tested API, not a duplicated/extracted service (2026-06-06) — Accepted

The cockpit pages for **gift cards** and **resources/assets** need their backend.
That logic lives in `apps/api` (services/routes), is live-verified, and is the
single source of truth for the **gift-card money ledger** (D-014/15/16/18) and
**shared-asset capacity** (D-024/26). Three options were weighed:

1. **Re-implement in the admin via `withTenant`** (the usual admin direct-DB path,
   D-007) — rejected: duplicating the signed-ledger + overspend-safe decrement (or
   the resource-pool overlap math) is exactly the drift D-014's design forbids;
   two implementations of a money invariant is a liability.
2. **Extract the services into `@marina/core`** so both API + admin call one copy —
   rejected for now: `@marina/core` is deliberately *pure* (money/pricing/
   availability math + zod, deps = types/cuid2/zod). These services use `withTenant`
   / Prisma, so extracting them would add `@marina/database` as a core dependency
   and change core's nature, plus risk regressing the 167 live API tests for no
   user-visible gain.
3. **Admin Server Actions call the Hono API over HTTP** — chosen. Reuses the
   proven, live-tested endpoints as the one source of truth, matching the existing
   `orders/actions.ts → dispatchConfirmationEmail` precedent.

Implemented as `apps/admin/lib/apiClient.ts` (apiGet/apiPost/apiPatch/apiDelete +
`AdminApiError`). Auth is server-to-server: `x-operator-id` (trusted tenant resolve)
+ the `x-dev-staff-id` shim carrying the current staff's `auth_user_id` so the API's
`requireStaff` applies the right RBAC. **Prod follow-up:** when `REQUIRE_CLERK_AUTH`
is on, the API requires a verified Clerk bearer and ignores the shim — forwarding the
admin's Clerk token to the API is the remaining piece (tracked ROADMAP Phase 3). All
Clerk enforcement is owner-gated/off today, so the shim path is correct now.

**Why:** one implementation of every money/capacity invariant, reusing what's
already hardened and tested, with the least new surface and zero risk to the proven
backend — at the cost of one deferred prod-auth wiring step that's already on the
go-live list anyway.

## D-030 — Tenant middleware accepts a validated `x-operator-id` for trusted server-to-server (2026-06-06) — Accepted

Live verification of the cockpit (task 1.8) surfaced that the documented
server-to-server resolution path was broken: the admin's `dispatchConfirmationEmail`
precedent (and the new D-029 `apiClient`) send `x-operator-id`, but the tenant
middleware only resolved `x-operator-slug`/Host → every admin→API call 400'd ("No
tenant specified"). The admin naturally holds the operator **id**, not the slug, and
`resolve_operator_id` matches only `slug`/`custom_domain`, so even sending the id as
the slug header would 404.

**Decision:** add a resolution step 0 to `tenantMiddleware` — if `x-operator-id` is
present, **validate it against an active `Operator`** (via `adminPrisma`) and scope to
it; an unknown/inactive id is rejected (404), never used to set the RLS GUC. Falls
through to the existing slug/Host resolution otherwise.

- **Trust model unchanged:** this is the same posture as the existing `x-operator-slug`
  header — a trusted internal-caller input. Public browser traffic resolves by Host;
  the header paths are for server-to-server/dev callers behind the network boundary.
  Accepting an id is no more permissive than accepting a slug, and it is validated
  before use.
- **Isolation re-verified:** because this touches isolation-critical code, the
  cross-tenant isolation suite was re-run **live vs Neon → 8/8** after the change
  (reads, writes, WITH CHECK, FK-attach, bulk, symmetric). No regression. Downstream
  scoping is unchanged — it still goes through `forOperator(operatorId)` exactly as the
  slug path does.

**Why:** make the documented "server-to-server convenience" actually work (fixing both
the new admin client and the pre-existing resend precedent) at the one correct place —
the tenant boundary — with validation and a live isolation re-proof, rather than
papering over it client-side with a slug lookup the admin doesn't have.

## D-031 — Server pages must hand Client Components serializable props (RSC-boundary fixes) (2026-06-06) — Accepted

The 1.8 server-render smoke (booting both apps in prod and hitting every route) caught
two **pre-existing** runtime 500s — latent because the frontend had never actually been
run (everything was `🧪`). Both are React Server Component boundary violations:

1. **`/activities`** — a Server Component built `DataTable` column defs containing `cell`
   render **functions** and passed them to the (client) `DataTable`. Functions can't
   cross the server→client boundary. **Fix:** moved the table into a Client Component
   (`components/activities/ActivitiesTable.tsx`); the page now passes only serializable
   `rows` + `canWrite` — the same pattern the working customers/staff tables already use.
2. **`/settings`** — the Server Component imported `SETTINGS_TABS` from the `'use client'`
   `SettingsNav.tsx` and `.map()`ped it ("Attempted to call map() from the server but map
   is on the client"). **Fix:** extracted the list into a client-safe `settings/tabs.ts`
   (no `'use client'`), imported by both the client nav and the server page — mirroring the
   `reports/kinds.ts` split.

**General rule (recorded):** a Server Component may pass a Client Component only
serializable props — never functions/render-props, and never map over a value imported
from a `'use client'` module. Put shared constants/lists in a plain module, and put any
columns/handlers inside the Client Component. (Companion to the D-009-era "client comps
import shell LEAF files, not the server-only barrel" rule, which also bit `ResourcesClient`
this phase.)

**Why:** "zero broken routes" is a core product promise (CONTEXT § rock solid) and a
go-live item. Build-green is necessary but not sufficient — only running the app catches
request-time RSC violations, so the verification pass standing the app up is what made the
product actually reachable.

## D-032 — Self-serve tenant provisioning: a platform endpoint outside the tenant boundary (2026-06-06) — Accepted

Phase 2's front door needs to create a brand-new tenant from a public signup — the one
operation that runs BEFORE any tenant scope exists.

- **Service** `apps/api/src/services/provisioning.ts` `provisionOperator()` uses the
  platform `adminPrisma` connection (like the seed), in one transaction creating:
  Operator (unique slug + unique `location_code`, brand defaults, `plan:'trial'`) +
  default Location + a starter liability Waiver + checkout config Integration + the first
  OWNER StaffMember bound to the signup identity. Slug is normalized + validated against a
  reserved list + checked unique (with a suggestion); `location_code` is derived from the
  business-name initials and made unique (it's the order-number prefix).
- **Endpoint** `POST /signup` (+ `GET /signup/slug-available`) is mounted **outside**
  `tenantMiddleware` (alongside `/webhooks`, `/jobs`) because there is no tenant to resolve
  yet. **Auth posture (mirrors D-012/D-017):** when Clerk is enforced, the OWNER
  `auth_user_id` MUST come from a verified Clerk bearer (the just-created user) and the body
  value is ignored; in dev it's open and a deterministic `owner-<cuid>` id is generated.
  Public-prod abuse protection (rate limit / captcha) is a documented go-live follow-up.
- **Isolation:** provisioning only ever CREATES a new operator + rows stamped with that new
  `operator_id`; it never reads/writes another tenant. RLS is table-wide so the new tenant
  is covered with no per-tenant DDL. Verified live: a fresh operator's owner cannot read the
  seed tenant (403), and the isolation suite stays **8/8**.
- **Dev handoff:** so a freshly-provisioned operator actually becomes the active admin
  context in dev (the dev fallback is otherwise pinned to the seed operator), the signup flow
  sets an `mb_dev_operator` cookie `{operatorId, authUserId}` that `getOperatorContext`'s
  **dev path only** honors (validated against a real staff row; never consulted under Clerk).

**Why:** tenant creation is inherently a pre-tenant, platform-level write — putting it behind
the tenant middleware would be incoherent. Keeping it a thin validated endpoint over an
adminPrisma transaction (the seed's proven shape) makes "a stranger can create a tenant"
real, while the Clerk-gated identity + table-wide RLS keep it safe.

## D-033 — Storefront brand resolves from the operator, not env (true per-tenant white-label) (2026-06-06) — Accepted

The customer web storefront previously read its brand from `process.env` (`getBrand()` was
sync), making it single-brand per deployment — incompatible with multi-tenant white-label.

- `getBrand()` is now **async**, fetching `GET /api/operator/public` (the API resolves the
  tenant from the `x-operator-slug`/host) and mapping name/color/logos to the `Brand` shape;
  env values + neutral defaults remain a **graceful fallback** when the API is unreachable
  (the build-time prerender hits this path harmlessly). All ~13 call sites now `await`.
- The root layout's static `metadata.title` ('Book Your Adventure') was a white-label LEAK —
  every tenant shared one browser-tab/share title. Replaced with an async `generateMetadata()`
  that titles from the operator brand (`%s · <brand>` template). Verified live: with
  `OPERATOR_SLUG=lake-sonoma` the storefront title is "Lake Sonoma Marina" and the env default
  no longer appears anywhere.

**Why:** white-label is the product's core promise (CONTEXT) — the storefront must render as
the operator's brand everywhere, including metadata, resolved per request from the operator the
host maps to, with a safe fallback so a brand-fetch failure never 500s the storefront.

## D-034 — Go-live ops: structured observability, readiness, dependency-free rate limiting (2026-06-06) — Accepted

Phase 3 hardened the API for production without adding heavy dependencies or owner accounts.

- **Observability** (`middleware/observability.ts`): `requestLogger` emits one structured JSON
  line per request (requestId, method, path, status, durationMs, operatorId) + an `x-request-id`
  response header for correlation. `app.onError` now uses `errorHandler`, which maps known error
  classes (AuthorizationError → 403; typed service errors with a numeric `.status`/`.code` →
  that status) and returns a **safe** `500 {error, requestId}` for everything else — no stack or
  message leak. `captureError` is a dependency-free **seam**: when `ERROR_DSN`/`SENTRY_DSN` is set
  it emits a tagged structured error; an APM SDK call drops in there (no SDK added now to keep the
  dep surface clean). `/ready` (DB ping) joins `/health` for deploy health gates.
- **Rate limiting / security** (`middleware/rateLimit.ts`): an in-memory fixed-window limiter
  (keyed by client IP + route name) on the abuse-prone public endpoints — signup 5/min,
  slug-check 30/min, customer-OTP 5/min, booking 20/min — returning `429 + Retry-After` +
  `X-RateLimit-*`. Plus `securityHeaders` (nosniff / frame-deny / referrer / cross-domain).
  **Caveat (documented):** the store is per-instance; swap for Redis/Upstash when running >1
  instance. Limiters mount *before* the tenant lookup so abuse is rejected cheaply.
- **Wiring:** the orchestrator (not the agents) wired these into `app.ts` + `signup.ts`, keeping
  the middleware modules standalone. Added a typed `requestId?` to the `Env` Variables.

Verified live: `/ready` → `{ok,db:up}`; 401/404 return safe envelopes with `x-request-id` +
security headers; 5×201 then `429 (Retry-After: 53)` on signup; **isolation suite still 8/8**.

**Why:** you can't run a money product in production blind or unprotected. Structured logs +
request ids make incidents debuggable, a safe error envelope stops info leaks, readiness enables
zero-downtime deploys, and rate limits stop the public front door (signup/OTP/booking) from being
hammered — all built dependency-free so it ships today and an APM/Redis plugs into the seams later.

## D-035 — 3-D Secure / SCA done right + payment idempotency (closes D-013 gap) (2026-06-06) — Accepted

D-013 deferred SCA: a PaymentIntent that came back `requires_action` was treated as a decline,
so real 3DS cards failed. Phase 3 closes it (code-complete; live verification needs Stripe keys,
which are owner-blocked).

- **Service** (`stripe.ts`): `createPayment` now returns a discriminated union — `{status:'succeeded', …}`
  (persist immediately) or `{status:'requires_action', clientSecret, paymentIntentId}` (don't
  charge yet). Genuine declines still throw `402`. A new `finalizePayment(paymentIntentId)`
  retrieves the intent and, if `succeeded`, returns the same normalized shape so the confirm path
  persists identically (shared `persistSettledCharge` helper — byte-for-byte identical to the sync
  success path).
- **Route** (`payments.ts`): `POST /payments/charge` returns `200 {requiresAction, clientSecret,
  paymentIntentId}` on SCA without recording a paid Payment; `POST /payments/confirm
  {paymentIntentId, orderId}` finalizes after the browser completes the challenge.
- **Web** (`PaymentSection`/`CheckoutClient`): on `requiresAction`, runs `stripe.handleNextAction`
  then calls confirm; the no-3DS happy path is unchanged.
- **Idempotency:** the charge route honors a client `Idempotency-Key` header → passed to Stripe,
  so a double-submit returns the same charge instead of double-charging.
- **Bug fixed in passing:** `apps/web/lib/api.ts` `submitPayment` pointed at a non-existent
  `/api/orders/:id/payments`; corrected to `POST /api/payments/charge` (the real endpoint).

**Why:** SCA is mandatory in many markets and a silent decline of 3DS cards is lost revenue +
a broken checkout. Returning an actionable `client_secret` and finalizing through one shared
persistence path makes the two flows consistent, while the idempotency key removes the
double-charge risk that's unacceptable on a money path.
