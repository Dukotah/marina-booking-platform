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
