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

## D-014 — Shared-resource capacity engine (2026-07-06) — Accepted

The operational moat over Singenuity/FareHarbor: a physical **Resource** (a pool of
interchangeable units — jet skis, pontoons, kayaks, guides) can back **multiple**
activities, and its capacity is enforced ACROSS them. Booking any activity that draws
from a resource reserves seats on it for the booking's time window, so the same boat
can't be sold twice through two different activities at the same time.

- **Model:** `Resource` (already existed: `quantity`, `seat_capacity`,
  `out_of_service_qty`, M2M `ActivityResources`). New **`ResourceBooking`** table
  records `(resource, order_item, seats, starts_at, ends_at)`. Pool seats =
  `(quantity - out_of_service_qty) * seat_capacity`. A booking of N participants
  consumes N seats (participant-seat model). Migration
  `20260706151029_resource_bookings`; both `Resource` and `OrderItem` gained
  `@@unique([operator_id, id])` so `ResourceBooking` uses tenant-composite FKs (D-011);
  added to `rls.sql`.
- **Availability = overlap query:** for a window [start, end) (start = timeslot
  datetime, end = start + rate.duration_minutes), a pool's used seats = sum of
  `ResourceBooking.seats` where `starts_at < end AND ends_at > start`. This layers ON
  TOP of the existing per-timeslot capacity; activities with no linked resources behave
  exactly as before (fully backward compatible).
- **Wiring:** `apps/api/src/services/resources.ts` holds the pure helpers (return
  conflicts, no throw → no import cycle). `booking.ts` checks + reserves on create,
  releases on cancel, and re-windows (re-checking, excluding its own hold) on
  reschedule.
- **Bug found + fixed alongside:** order-number sequence counted orders by `created_at`
  within the *slot's* calendar day, so two bookings for the same FUTURE day both got
  seq 1 → duplicate order_number. Now counts by the `<CODE><YYMMDD>` order-number
  prefix. Verified: API typecheck clean, **26/26 API tests green** incl. a new
  `resource-capacity.integration.test.ts` proving cross-activity blocking (book A →
  overlapping B refused → non-overlapping B allowed → cancel A frees B).

**Why:** FareHarbor's real edge is operational density; shared-resource auto-blocking is
the single highest-value piece. Modelling it as time-windowed reservations (not a
per-slot counter) is what makes cross-activity and cross-time overlap correct.

**Follow-ups (not yet built):** (1) reflect resource limits in the customer-facing
availability calendar (enforcement already prevents overselling; the calendar can still
show an over-optimistic slot that fails at checkout); (2) admin UI to manage resource
pools + link them to activities (today only settable via DB/seed); (3) seed a shared
pool so the local dogfood shows it live.

## D-015 — Automated pre-arrival reminders via an event-tracked sweep (2026-07-07) — Accepted

No-shows are a top operator pain; FareHarbor's automated reminders are part of its
edge. We add the automation the codebase was missing (confirmation + reminder emails
already existed; nothing triggered reminders on a schedule).

- **Engine** (`apps/api/src/services/notifications.ts`): `selectDueReminderOrderIds`
  (UPCOMING orders with a non-cancelled item whose timeslot starts in the window and
  no prior REMINDER_SENT event) → `runDueReminders(operatorId, {withinHours})` sends
  each via the existing `sendReminder` and stamps a **`REMINDER_SENT` OrderEvent** →
  `runAllDueReminders` sweeps every active operator.
- **Dedup without a migration:** idempotency is tracked with an OrderEvent (type
  `REMINDER_SENT`, metadata `{delivered, providerId, reason}`), not a new column — so
  it's migration-free and shows in the order's audit history. An order is reminded at
  most once; without `RESEND_API_KEY` the send no-ops but the order is still stamped
  (delivered:false), keeping the sweep idempotent in dev.
- **Trigger** (`apps/api/src/routes/internal.ts`): `POST /internal/reminders/run`
  (`?withinHours=`, default 24, clamped 1–168), mounted OUTSIDE the tenant middleware
  (no tenant context; sweeps all operators). Secret-gated by `CRON_SECRET`
  (`Authorization: Bearer` or `x-cron-secret`); open when unset, matching the Stripe
  webhook posture. A cron (Vercel Cron / GH Action) hits it on a schedule at deploy.
- Verified: API typecheck clean, **29/29 API tests** incl. new
  `reminders.integration.test.ts` (selection window, idempotent dedup, cancelled
  excluded) — all pass with NO email provider configured.

**Why:** the selection + dedup + audit is the hard, correctness-critical part and it's
fully testable offline; the actual email delivery is a config flip (Resend key) on the
existing no-op path. **Follow-up:** add an SMS channel (Twilio) to the same sweep, and
a cron schedule config at deploy.
