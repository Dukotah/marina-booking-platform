# Roadmap & Status Board

Live status of the build. Agents: update the **Status** column as you complete work,
and add a dated line to the Changelog at the bottom.

Legend: ⬜ not started · 🟦 in progress · ✅ done · ⏸️ blocked (needs owner)

## Now / next

The immediate goal is a hardened multi-tenant foundation, then the first end-to-end
booking vertical slice for the seed client (Lake Sonoma Marina) running on it.

## Phase 0 — Foundation

| # | Item | Status |
|---|---|---|
| 0.1 | Shared-brain docs (this folder) | ✅ |
| 0.2 | Monorepo scaffold (Turborepo + pnpm) — root config, types + database packages, installs + typechecks clean | ✅ |
| 0.3 | Prisma schema w/ multi-tenant hardening (Operator, Location, Activity+config, Rate, Timeslot, Resource, Order, OrderItem, Payment, Customer, StaffMember+RBAC, Integration, Waiver) — validates + generates | ✅ |
| 0.4 | Postgres RLS policies (prisma/rls.sql) + tenant-scoped Prisma client (forOperator/withTenant) | ✅ (written; applies on first DB connect) |
| 0.5 | Neon dev database connected + first migration run | ✅ (Neon US-West; migration `init` applied; RLS applied; `app_user` non-bypass role provisioned) |
| 0.6 | Seed script — Lake Sonoma Marina (19 activities, rates, fees, waiver, config) | ✅ (seeded live — operator `lsra`, 19 activities) |
| 0.7 | Auth + RBAC (Clerk operators/staff, magic link customers) | 🟦 (staff/operator Clerk **wired + verified** — admin middleware + /sign-in,/sign-up + API bearer verification, gated behind `REQUIRE_CLERK_AUTH`; flip on after Clerk dashboard setup, see D-012. Magic-link **customer** auth on web still pending) |
| 0.8 | Cross-tenant isolation tests (must fail to access other tenants) | ✅ (live vs Neon — now **8/8**: reads, writes, WITH CHECK, bulk ops, symmetric, **+ cross-tenant FK attach** un-skipped after 0.13) |
| 0.9 | Auth/RBAC package (@marina/auth) — permission checks, AuthContext | ✅ |
| 0.10 | API skeleton (Hono) — tenant-resolution middleware, RLS-scoped client per request, dev auth shim, catalog route; boots + tenant guard verified | ✅ |
| 0.11 | Customer portal shell (apps/web, Next 14 + Tailwind) — catalog page wired to API, white-label brand var, graceful no-DB state | ✅ |
| 0.12 | Admin dashboard shell (apps/admin, Next 14 + Tailwind) — dashboard-first KPI layout + nav | ✅ |
| 0.13 | **Hardening: tenant-composite FKs** — `@@unique([operator_id, id])` on parents + composite child relations so the DB refuses cross-tenant FK references (closes the D-010 gap; un-skips the isolation case) | ✅ (migration `tenant_composite_fks` applied live; isolation suite now 8/8; see D-011) |

## Phase 1 — MVP (sellable booking core)

| # | Item | Status |
|---|---|---|
Status key for Phase 1: ✅🧪 = code complete, typechecks + builds, but not yet
exercised against a live DB/keys (waiting on 0.5 Neon + service keys).

| # | Item | Status |
|---|---|---|
| 1.1 | Operator onboarding wizard (brand, location, first activities) | ✅🧪 |
| 1.2 | Activity CRUD (simplified wizard, generic categories) | ✅🧪 |
| 1.3 | Customer portal: catalog → date → time → rate → checkout | ✅🧪 (booking **service** now live-verified vs Neon — pricing/capacity/order graph; UI flow still 🧪) |
| 1.4 | Availability calendar (color-coded) + capacity-aware time slots | ✅🧪 |
| 1.5 | Stripe payments (test mode, PaymentIntents + Elements) | ✅🧪 (switched from Square → Stripe per D-013; needs Stripe keys to charge; 3DS/SCA is a follow-up) |
| 1.6 | Order list + detail + cancel + refund (full & partial) | ✅🧪 (list + detail + cancel now **live-verified via full HTTP** — status/search/pagination filters, public-by-number fetch, staff cancel restores capacity + idempotency guard; refund still 🧪 — needs Stripe) |
| 1.7 | Email confirmation + reminder (Resend) | ✅🧪 (send-path built **and now wired**: booking-create fires confirmation + staff-new-booking; refund fires the receipt — fire-and-forget, guarded by `isEmailConfigured()` so it's a true no-op without a key. Flows go live the moment `RESEND_API_KEY` is set. Reminder still needs a scheduled job; POS-sale confirmation is a trivial follow-up) |
| 1.8 | Day Gantt manifest (visual, color-coded) + week calendar | ✅🧪 |
| 1.9 | Digital waiver signing + audit trail | ✅🧪 (waiver sign + audit **live-verified** via full HTTP path — signature recorded, item/customer flags flipped, staff list + auth guard) |
| 1.10 | Dashboard home (revenue/occupancy KPIs, alerts, upcoming) | ✅🧪 |
| 1.11 | Full white-label theming per tenant | ✅🧪 (brand var; logo upload later) |

## Phase 2 — Core operations

Merchandise POS (integrated) · gift cards · promo codes · customer CRM ·
reports + CSV export · staff roles/permissions UI · SMS (Twilio) ·
customer self-service reschedule.

| # | Item | Status |
|---|---|---|
| 2.1 | **Customer self-service reschedule** — `rescheduleBooking` service (capacity move + `self_reschedule_hours` window) + staff `POST /orders/:id/reschedule` + customer `POST /orders/:orderNumber/self-reschedule` (email-gated) + **web account slot-picker UI** (RescheduleFlow → server actions) | ✅ full-stack (backend live-verified 5/5; web typechecks + builds) |
| 2.2 | **Gift cards (backend)** — `GiftCard` + `GiftCardTransaction` models (signed ledger, tenant-composite FK) + `issueGiftCard`/`redeemGiftCard`/`getGiftCardByCode` service (atomic, overspend-safe conditional decrement) + staff `POST /giftcards` (issue) · `GET /giftcards` (list) · `POST /giftcards/:code/redeem` + public `GET /giftcards/:code/balance` | ✅ backend live-verified 6/6 (D-014). Admin UI is a follow-up |
| 2.3 | **Gift card as tender** — `applyGiftCardToOrder` service (one atomic tx: overspend-safe card draw-down + `Payment{GIFT_CARD}` + order balance update + signed ledger entry stamped with the order id + audit event) + staff `POST /payments/gift-card` | ✅ backend live-verified 5/5 (D-015). Needs no Stripe (stored value). Customer-checkout tender (ties into customer auth) is the follow-up |
| 2.4 | **Reports + CSV export** — staff (`report:read`) `GET /reports/revenue` + `/reports/bookings` (date-range filtered; gross/discount/tax/tip/refund/net + per-day breakdown; status + top-activity counts) and `.csv` downloads | ✅ backend live-verified 15/15 |
| 2.5 | **Gift card payment refund** — `refundGiftCardPayment` service (one atomic tx: credit the originating card back via the payment's linked ledger entry + positive `REFUND` entry + advance Payment status + roll order back) wired into a now-tender-polymorphic `POST /payments/:id/refund` (GIFT_CARD → card credit, no Stripe; card → Stripe) | ✅ backend live-verified (D-016). Closes the stored-value money loop (issue → tender → refund) |

## Phase 3 — Power features (the moat for complex customers)

Resource/asset management · guide scheduling · package builder + upsells ·
**multi-location dashboards + roll-up reporting** · dynamic pricing · kiosk mode ·
channel/OTA + affiliate management · accounting exports (QuickBooks/Xero).

## Go-live checklist (before selling)

- [ ] Cross-tenant isolation tests pass
- [ ] Payment + refund flows tested end-to-end in Stripe (test → live)
- [ ] Waiver capture legally reviewed + audit trail verified
- [ ] Zero broken routes (route test sweep)
- [ ] Backups + error monitoring configured
- [ ] Custom domain / subdomain white-label verified for a test tenant

## Blocked-on-owner (deferred external accounts)

Neon connection string · Clerk keys · Stripe test→live keys + webhook secret · Resend
key · Twilio (later) · Cloudflare R2 · Vercel + Railway deploy accounts.
I will build against sandboxes/free tiers and flag exactly when each is needed.

## Changelog

- **2026-06-05** — **Notification flows wired (1.7 integrated).** The transactional-email
  send path existed but was never *called*. Wired it: booking-create (`POST /orders`, and the
  `/bookings` alias) fires `sendBookingConfirmation` + `sendStaffNewBooking`; both refund
  branches (gift-card + Stripe) fire `sendRefundReceipt`. All fire-and-forget (`void`), never
  block or fail the response. Added `isEmailConfigured()` to the notifications service and
  guard every call site with it, so a deployment without `RESEND_API_KEY` does ZERO work (no
  DB load, no floating promise) — the moment a key is set, emails flow. 117 tests stay green
  (wiring is dark without a key); typecheck 9/9. Follow-ups: reminder needs a scheduled job;
  POS-sale confirmation is a one-liner. Held locally, not pushed (Vercel quota).
- **2026-06-05** — **Gift card payment refund (2.5, D-016) — closes the money loop.** New
  `refundGiftCardPayment` service (one tenant tx): resolves the originating card via the
  Payment's linked ledger entry (`processor_transaction_id` → REDEEM `GiftCardTransaction` →
  card), credits the card balance back with a positive `REFUND` ledger entry (stamped with
  the order id), advances the Payment's `refunded_cents`/`status`, and rolls the order's
  amount_paid/balance_due back. `POST /api/payments/:id/refund` is now **polymorphic by
  tender** — a GIFT_CARD payment credits the card (stored value, no Stripe gate); a card
  payment still settles through Stripe. Stored-value loop is now complete: issue (D-014) →
  redeem/tender (D-015) → refund (D-016). Live test added to the tender suite (full refund
  credits the card + rolls the order back + positive REFUND entry + double-refund refused).
  api suite **116 → 117**; grand total **193 → 194 green**. typecheck 9/9. Held locally, not
  pushed (Vercel quota).
- **2026-06-05** — **Gift-card tender + Reports/CSV + public-catalog verification.** Lean
  parallel round (2 background Sonnet agents on safe independent work; the money path
  authored directly + reviewed). (1) **Gift card as tender (2.3, D-015):** new
  `applyGiftCardToOrder` service does the whole thing in ONE tenant tx — overspend-safe
  guarded card decrement, a signed REDEEM ledger entry stamped with the order id, a
  `Payment{method:GIFT_CARD}` linked to that ledger entry, the order's
  amount_paid/balance_due advanced, and an OrderEvent — exposed as staff
  `POST /api/payments/gift-card` (order:write; needs no Stripe). Applies
  min(requested|card balance|balance due); refuses over-balance-due / over-card-balance /
  already-settled. Live 5/5. (2) **Reports + CSV export (2.4):** `routes/reports.ts` —
  `/reports/revenue` + `/reports/bookings` (+ `.csv`), date-range filtered, report:read-gated,
  CANCELLED excluded from revenue; no new deps. Live 15/15. (3) **Public catalog/availability
  verification:** `catalog.integration.test.ts` over the public activities/availability/operator
  endpoints — 12/12, no route bugs. api suite **84 → 116**; grand total **161 → 193 green**
  (core 69 + isolation 8 + api 116). typecheck 9/9. Held locally, not pushed (Vercel quota).
- **2026-06-05** — **Live-verification sweep: orders, merchandise, POS, customers (HTTP).**
  Ran a lean 4-agent parallel fan-out (Sonnet) to turn the remaining Phase-1/2 `✅🧪` API
  surface into live-verified, each agent writing one new `app.request` integration suite
  against the LSRA Neon tenant (proven template: `skipIf` no DB, dev-owner staff shim,
  self-cleanup): **orders** (list status/search/pagination, public-by-number detail + 404,
  staff cancel restores capacity + 401/409 idempotency — 16), **merchandise** (CRUD +
  name/active filters + soft/hard delete + low-stock flag + 401s — 19), **POS** (CASH/COMP
  sales create Order+Payment, `unitPriceCentsOverride`, capacity 409, search by
  order/customer + type filter, 401/400 guards — 11), **customers** (list/search/tag, detail
  + 404, create + dup-409, patch + empty-patch 400, 401s — 14). **No route bugs found** —
  the agents touched no shared/route files. One test-only bug fixed: the POS suite deleted
  in-test timeslots in a per-test `finally` before `afterAll` removed the referencing orders
  (OrderItem→Timeslot composite FK violation) — now the slots are swept in `afterAll` after
  their orders; also cleaned 2 orphan slots (`booked=1/20`) the failed first run left in the
  seed tenant (a raw order delete doesn't restore slot capacity). api suite **24 → 84**;
  grand total **101 → 161 green** (core 69 + isolation 8 + api 84). typecheck 9/9. Held
  locally, not pushed (Vercel quota).
- **2026-06-05** — **Gift cards backend slice (2.2) — live-verified (D-014).** New
  `GiftCard` + `GiftCardTransaction` models: balance in integer cents is authoritative
  and every change appends a *signed* ledger row (`+ISSUE/REFUND`, `−REDEEM`) so the
  ledger sums to the balance; `GiftCardTransaction` references its card via a
  tenant-composite FK `(operator_id, gift_card_id) -> GiftCard(operator_id, id)` (D-011).
  Migration `20260605130000_gift_cards` applied live to Neon (clean additive diff, zero
  drift); both tables added to `rls.sql` + `db:rls`/`db:approle` re-run so RLS + app_user
  grants cover them. Service `services/giftcards.ts`: `issueGiftCard` (unique grouped code
  from `generateGiftCardCode`, retries on collision, ISSUE entry), `redeemGiftCard`
  (**overspend-safe** — a conditional `updateMany` guarded on `is_active` + `balance >=
  amount` is the arbiter, not a read-then-write race; checks expiry; signed REDEEM entry),
  `getGiftCardByCode`. Routes `routes/giftcards.ts`: staff `POST /giftcards` (order:write,
  issue) · `GET /giftcards` (order:read, list) · `POST /giftcards/:code/redeem`
  (order:write) + public `GET /giftcards/:code/balance` (the code is the bearer secret).
  Added `generateGiftCardCode` to `@marina/core`. New live suite 6/6 (issue+ISSUE ledger,
  partial redeem+signed entry, over-redeem refused/balance untouched, public balance HTTP,
  staff redeem HTTP, 401 without staff identity). Verified: typecheck 9/9, build 3/3, core
  69 + isolation 8 + api 24 = **101 green**. Customer-checkout redemption (ties into the
  payment flow) + admin UI are documented follow-ups. Held locally, not pushed (Vercel
  quota).
- **2026-06-04** — **Reschedule web UI (2.1 now full-stack).** Wired the customer account
  area to the self-service endpoint: `RescheduleFlow` client component (date picker → open
  slots for that day → confirm) backed by two server actions (`fetchRescheduleSlots`,
  `rescheduleBookingAction`) + a `selfReschedule` API client method; `ManagePanel` now
  opens the in-page flow instead of linking to rebooking. Web typechecks + builds. (This
  commit and onward are **held locally, not pushed** — owner flagged the Vercel build
  quota; push when it clears.)
- **2026-06-04** — **Customer self-service reschedule (2.1) — backend + live-verified.**
  New `rescheduleBooking` service moves a booking's item to another slot of the same
  activity: releases the old slot's capacity, takes the new one (recomputing status),
  repoints the item, logs a `RESCHEDULED` event, and enforces the activity's
  `self_reschedule_hours` window for the CUSTOMER channel (staff bypass). Endpoints: staff
  `POST /orders/:id/reschedule` (order:write) + customer `POST
  /orders/:orderNumber/self-reschedule` (email-gated, 404s without leaking order numbers).
  Live suite 5/5 (capacity move, capacity guard, window enforcement, HTTP success +
  wrong-email 404). Also added `apps/api/vitest.config.ts` (fileParallelism:false) — the
  live suites share one Neon tenant + singleton Prisma client, so they must run
  sequentially (a parallel afterAll `$disconnect()` was tearing the pool out mid-run).
  API suite now 18; grand total 95 green. Remaining: the web account slot-picker UI.
- **2026-06-04** — **Payments switched from Square → Stripe (D-013).** Removed the
  `square` SDK + `services/square.ts`; added `services/stripe.ts` (PaymentIntents) with
  the same interface the routes used, so `routes/payments.ts` only swapped imports +
  `processor: 'STRIPE'`. Rewrote `routes/webhooks.ts` for Stripe
  (`/webhooks/stripe`, signed). Frontend: `square-config`→`stripe-config`, `PaymentSection`
  rebuilt on `@stripe/react-stripe-js` (`CardElement` → PaymentMethod), `CheckoutClient`/
  page prop `square`→`stripe`. Admin catalog: Stripe is now the sole card processor.
  Schema: `Payment.processor` default → `STRIPE` (migration applied live). Env: `SQUARE_*`
  → `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.
  3DS/SCA handling is a documented follow-up. Verified: typecheck 9/9, build 3/3, 90/90
  tests green (none charge a card; live charge still needs keys).
- **2026-06-04** — **Promo discounts verified live in the booking path.** A disposable
  active percent-off code is resolved server-side, applied to pricing (matches
  `@marina/core` `discountCents`/`totalCents`), and increments `times_redeemed` exactly
  once; the seed's inactive+expired `LASTSPLASH` is rejected (`BookingError`). **2/2 live;
  no bugs.** API suite now 13 (booking 3 + availability 3 + waivers 5 + promo 2); grand
  total 90 green.
- **2026-06-04** — **Waiver capture verified live via the full HTTP stack.** Added a
  `app.request(...)` integration suite (real Hono app → tenant middleware → RLS client →
  zod → handler → dev-staff shim): `POST /waivers/sign` records the signature and flips
  the order-item + customer waiver flags in one transaction, a minor-without-guardian is
  rejected (400), `GET /waivers/active` returns the template, and the staff list both
  works (dev-staff shim) and 401s without an identity. **5/5 live; no bugs.** First
  HTTP-level (not service-level) test — proves tenant resolution + RLS + auth end to end.
  API suite now 11 (booking 3 + availability 3 + waivers 5); grand total 88 green.
- **2026-06-04** — **Booking funnel verified live against Neon (first Phase-1 `🧪`→live).**
  Added `apps/api` vitest + two integration suites against the seeded LSRA tenant:
  **booking** (`createBooking` server-recomputed pricing matches `@marina/core`, full
  order graph written, capacity decrements, overbooking refused, `cancelBooking` restores
  capacity) and **availability** (`generateTimeslotsForRange` creates evenly-spaced slots
  + is idempotent, `getDayAvailability` rolls up capacity/status, and a booking shows up
  in the slot on the next read). **6/6 pass live; no bugs found** in the sweep code.
  Suites skip without `DATABASE_URL` so `pnpm test` stays green. Test totals now: core 69
  + isolation 8 + api 6 (booking 3 + availability 3).
- **2026-06-04** — **0.7 (staff half) — Clerk auth wired behind a switch (D-012).**
  Replaced the dev auth shims with real Clerk auth for operators/staff, gated by a single
  `REQUIRE_CLERK_AUTH` flag (default off = dev fallback stays, so nothing locks out).
  Admin: `middleware.ts` (clerkMiddleware, conditional passthrough when keyless) +
  `/sign-in` & `/sign-up` catch-all routes; `lib/session` now honors the flag. API:
  `requireStaff` verifies a Clerk session token (`Authorization: Bearer`) via
  `@clerk/backend` when enforced, else the `x-dev-staff-id` shim. Added the Clerk
  URL/flag envs to `.env.example`. Verified: typecheck 9/9, build 3/3 (admin gains the 2
  routes + middleware), core 69/69. To go live: configure the Clerk dashboard + set
  `REQUIRE_CLERK_AUTH=true`. Magic-link **customer** auth (web) still pending for 0.7.
- **2026-06-04** — **0.13 tenant-composite FKs — Phase 0 hardening complete (D-011).**
  Closed the D-010 cross-tenant FK-attach gap: added `@@unique([operator_id, id])` to
  parent tables (Activity, Rate, Timeslot, Order, Customer, Waiver) and rewrote the
  required intra-tenant relations as composite FKs `(operator_id, parent_id) ->
  parent(operator_id, id)` (Rate/Timeslot→Activity, Order→Customer,
  OrderItem→order/activity/rate/timeslot, Payment/Note/OrderEvent→Order,
  WaiverSignature→Waiver). Migration `tenant_composite_fks` applied live to Neon (zero
  drift). Postgres now refuses a child row whose parent is another tenant's. Un-skipped
  the cross-tenant FK-attach isolation case — **live suite 8/8** (was 7/1-skip). Ripple:
  nested creates derive `operator_id` from the parent now, so dropped the explicit
  `operator_id` in the booking service's `items.create` (typecheck caught it). Residual
  (nullable/optional relations + StaffLocation + ActivityResources m2m) left as
  single-column, documented in D-011. Verified: typecheck 9/9, build 3/3, core 69/69,
  isolation 8/8.
- **2026-06-04** — **marina-admin Vercel deploy fix + customer-portal API wiring.**
  Root-caused the admin deploy failure as a Prisma/runtime packaging issue and fixed
  it: added the `rhel-openssl-3.0.x` Prisma binaryTarget (Vercel Linux engine); moved
  `@marina/database` from `serverComponentsExternalPackages` into `transpilePackages`
  so Next transpiles its TS source instead of `require()`-ing it; admin `build` (and a
  new `vercel.json`) now run `prisma generate` before `next build`. Wired the customer
  portal's expected endpoints: `GET /api/activities/:id` (public booking detail) +
  `GET /api/activities/:id/availability` (delegates to the availability service), and a
  `/bookings`→`/orders` alias to match web `lib/api.ts`. Seed now creates a `dev-owner`
  OWNER StaffMember (location-scoped via StaffLocation) so the `x-dev-staff-id` shim has
  a principal to load. Verified green: typecheck 9/9, build 3/3, core 69/69. (Live DB
  still needs a re-seed to pick up the new staff row.)
- **2026-06-04** — **Went live against a real database.** Neon Postgres connected
  (US-West); `prisma migrate dev` applied migration `init`; RLS applied; LSRA seeded
  (operator `lsra`, 19 activities). Two isolation findings fixed (D-010): (1) Neon's
  `neondb_owner` has BYPASSRLS — added a dedicated NOBYPASSRLS `app_user` role
  (`pnpm db:approle`) that `forOperator`/`withTenant` now connect through, leaving
  `adminPrisma` on the owner for platform ops; (2) `apply-rls.ts` now splits the .sql
  per statement (Prisma rejects multi-command prepared statements) and runs DDL on the
  direct connection. Cross-tenant isolation suite now runs LIVE and passes 7/7 (0.8
  done). Documented residual gap: Postgres FK checks bypass RLS, so cross-tenant FK
  attach is possible — tracked as 0.13 (tenant-composite FKs), the one isolation case
  skipped until then. Vercel: marina-web live; marina-admin first deploy failed on a
  build error (local typecheck+build are green — likely env/Linux-case specific; needs
  the Vercel log to pin down).
- **2026-06-04** — Resumed after interrupted session. Verified state still green
  (typecheck 0 errors; core 69/69; web 7-route + admin 21-route + api builds all pass).
  Wired the existing 8-case cross-tenant isolation suite into the test pipeline (added
  `vitest` + `test` script to `@marina/database`; suite skips with a clear message when
  `DATABASE_URL` is unset and auto-runs live once Neon is connected) — 0.8 moved ⬜→🟦.
  Added `docs/HANDOFF.md` (living next-session brief) and `docs/BROWSER-TAKEOVER.md`
  (copy-paste prompt for a browser-capable Claude to provision Neon/Vercel/Clerk/Square/
  Resend, since the local agent can't create third-party accounts).
- **2026-06-04** — Repo cloned locally. Shared-brain docs created (AGENTS.md +
  docs/CONTEXT, ARCHITECTURE, DECISIONS, ROADMAP). Decisions D-001..D-006 recorded.
  Toolchain checked (Node 24 ✓, pnpm via corepack, no Docker → Neon).
- **2026-06-04** — Phase 0 foundation built: monorepo scaffold (pnpm workspaces +
  turbo), `@marina/types` (RBAC perms, money helpers, tenant GUC), `@marina/database`
  (full multi-tenant Prisma schema, RLS policies, tenant-scoped client, LSRA seed).
  `pnpm install` + `prisma generate` + typecheck all pass. Not yet applied to a live
  DB — waiting on Neon connection string (0.5). Note: migrate package.json#prisma to
  prisma.config.ts before Prisma 7 (deprecation warning, non-blocking).
- **2026-06-04** — Auth + API scaffolded. `@marina/auth` (RBAC: effective
  permissions, hasPermission/assertPermission, location scoping, AuthContext).
  `@marina/api` (Hono): tenant-resolution middleware (host/subdomain/custom-domain →
  operator via SECURITY DEFINER resolver), RLS-scoped Prisma client attached per
  request, dev auth shim (header-based; swap for Clerk at 0.7), public catalog route
  + staff-only manage route. Boots clean; /health 200; /api guarded (400 without
  tenant). Typechecks pass. Added resolve_operator_id() to prisma/rls.sql.
- **2026-06-04** — **Phase 1 build sweep** (31-agent workflow, ~1.9M tokens). Built
  @marina/core (pricing/availability/ids/zod, 69 unit tests pass), @marina/ui (16
  components), @marina/emails (5 React Email templates); 10 API route groups
  (availability, orders+booking, payments [Square v44], customers, waivers, promos,
  merchandise, pos, operator, webhooks) + notifications service; customer web (catalog,
  activity detail+calendar, checkout, confirmation, account); admin (dashboard, Gantt
  manifest, calendar, orders+refunds, activity wizard, CRM, POS, reports, 5 settings
  pages, staff). Integration: wired all routers into app.ts; upgraded square 38→44 (new
  SquareClient API); relaxed noUncheckedIndexedAccess (D-009); added webpack
  extensionAlias for .js→.ts in both Next apps; fixed client/server boundaries
  ('use client' on ui dialog; client comps import shell leaf files not the barrel).
  RESULT: full monorepo typecheck 0 errors; web build (7 routes) + admin build (21
  routes) green; api build green. Not yet run against a live DB.
- **2026-06-04** — Frontend shells scaffolded. apps/web (Next 14, App Router,
  Tailwind): catalog page server-fetches the API by operator slug, renders
  category-grouped activity cards with from-pricing, white-label brand CSS var, and a
  graceful "DB not connected yet" state. apps/admin (Next 14): dashboard-first layout
  with KPI cards + nav (placeholders until orders API). Both typecheck clean. Added
  .gitattributes (LF normalization). Phase 0 scaffolding complete — remaining Phase 0
  items (0.5 Neon, 0.7 Clerk, 0.8 isolation tests) need owner-provided accounts.
