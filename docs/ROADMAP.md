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
| 0.7 | Auth + RBAC (Clerk operators/staff, magic link customers) | ✅ (staff/operator Clerk **wired + verified** (D-012). Customer email-OTP auth backend live-verified (D-017). **Customer web login UI now built** (Phase 1, 1.1): `/login` two-step OTP screen, httpOnly session cookie, session-aware account area + sign-out, bearer token forwarded to self-service calls. typecheck+web build green; browser E2E in the 1.8 pass.) |
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
| 1.7 | Email confirmation + reminder (Resend) | ✅ (all flows wired + live-tested: booking-create fires confirmation + staff-alert; refund fires the receipt; **POS-sale fires the customer confirmation** (D-019); **reminder = idempotent `sendDueReminders` sweep + secret-gated `POST /jobs/reminders` for a cron**, with an `Order.reminder_sent_at` stamp so it sends exactly once (D-019). All fire-and-forget, `isEmailConfigured()`-guarded — a no-op without a key, live the moment `RESEND_API_KEY` is set) |
| 1.8 | Day Gantt manifest (visual, color-coded) + week calendar | ✅🧪 |
| 1.9 | Digital waiver signing + audit trail | ✅ (waiver sign + audit **live-verified** via full HTTP path — signature recorded, item/customer flags flipped, staff list + auth guard. **+ versioned template management** (D-022): `GET/POST /waivers/templates` + `/:id/activate` — content is immutable per version (signatures reference the version signed), "edit" publishes a new version, exactly one active, operator:manage-gated; 5/5 live) |
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
| 2.3 | **Gift card as tender** — `applyGiftCardToOrder` service (one atomic tx: overspend-safe card draw-down + `Payment{GIFT_CARD}` + order balance update + signed ledger entry stamped with the order id + audit event) + staff `POST /payments/gift-card` + **customer self-service** `POST /payments/customer/gift-card` (token-gated, own-order-only) | ✅ backend live-verified — staff 5/5 (D-015) + customer 3/3 (D-017 token). Needs no Stripe (stored value) |
| 2.4 | **Reports + CSV export** — staff (`report:read`) `GET /reports/revenue` + `/reports/bookings` (date-range filtered; gross/discount/tax/tip/refund/net + per-day breakdown; status + top-activity counts) and `.csv` downloads | ✅ backend live-verified 15/15 |
| 2.5 | **Gift card payment refund** — `refundGiftCardPayment` service (one atomic tx: credit the originating card back via the payment's linked ledger entry + positive `REFUND` entry + advance Payment status + roll order back) wired into a now-tender-polymorphic `POST /payments/:id/refund` (GIFT_CARD → card credit, no Stripe; card → Stripe) | ✅ backend live-verified (D-016). Closes the stored-value money loop (issue → tender → refund) |

## Phase 3 — Power features (the moat for complex customers)

Resource/asset management · guide scheduling · package builder + upsells ·
**multi-location dashboards + roll-up reporting** · dynamic pricing · kiosk mode ·
channel/OTA + affiliate management · accounting exports (QuickBooks/Xero).

| # | Item | Status |
|---|---|---|
| 3.x | **Multi-location roll-up reporting (backend)** — `GET /reports/by-location` (+`.csv`): item-level location attribution (gross = unit×qty), per-location volume + a chain roll-up total (D-020) | 🟦 backend live-verified 3/3. Admin dashboards on top of it (+ per-location filtering of `/revenue`,`/bookings`, per-location net) are follow-ups |
| 3.x | **Accounting export (backend)** — `GET /reports/transactions` (+`.csv`): payment-level journal keyed by cash date, net-of-refunds per row, per-tender reconciliation + totals (QuickBooks/Xero import) (D-021) | 🟦 backend live-verified 3/3. Direct QuickBooks/Xero API sync (OAuth + GL account mapping) is a later gated follow-up |
| 3.x | **Resource/asset management (backend)** — staff CRUD `/api/resources` + activity assignment (ActivityResources m2m); fields seat_capacity/quantity/out_of_service_qty, derived availableQty; tenant-validated refs (D-023) | ✅ catalog + assignment live-verified 7/7 |
| 3.x | **Resource-backed availability** — shared assets constrain capacity across every activity they back; OrderItem-level time-overlap by rate duration; enforced in **`createBooking` + POS sale + `rescheduleBooking`** (`INSUFFICIENT_RESOURCE_CAPACITY`) + overlaid on **both** `getDayAvailability` (`resourceConstrained`) **and** `getRangeAvailability` (month calendar day signals); **per-resource allocation mode** SHARED_SEATS / WHOLE_UNIT charter (D-024, D-026) | ✅ live-verified 10/10 — all three write paths, both reads, both allocation modes. Pillar complete |

## Go-live checklist (before selling)

- [ ] Cross-tenant isolation tests pass
- [ ] Payment + refund flows tested end-to-end in Stripe (test → live)
- [ ] Waiver capture legally reviewed + audit trail verified
- [x] Zero broken routes (route test sweep) — admin 21/21 + web all routes render 200 live
  (2026-06-06 server-render smoke); two pre-existing 500s fixed (D-031). Re-run after new pages.
- [ ] Backups + error monitoring configured
- [~] Custom domain / subdomain white-label verified for a test tenant — per-tenant brand now
  resolves from the operator (storefront name/title/header, no env leak; D-033). Custom-domain
  mapping + a live subdomain deploy still pending.

## Blocked-on-owner (deferred external accounts)

Neon connection string · Clerk keys · Stripe test→live keys + webhook secret · Resend
key · Twilio (later) · Cloudflare R2 · Vercel + Railway deploy accounts.
I will build against sandboxes/free tiers and flag exactly when each is needed.

## Changelog

- **2026-06-06** — **Phase 2: the self-serve front door — provisioning + signup + per-tenant
  white-label (tasks 2.0–2.5).** A stranger can now create a tenant with zero manual DB work.
  - **Provisioning foundation (me, D-032):** `provisionOperator` service + `POST /signup` +
    `GET /signup/slug-available`, mounted OUTSIDE the tenant middleware (pre-tenant, adminPrisma).
    Creates Operator (unique slug + location_code) + default Location + starter Waiver + checkout
    config + OWNER staff. Dev-open / Clerk-bearer-gated in prod. Live-verified: slug
    free/taken/reserved, 201 provision, new tenant resolves by its own slug, **isolation holds
    (fresh owner → 403 on the seed tenant; suite 8/8)**.
  - **Signup UI (agent):** public admin `/signup` — business name → live slug availability →
    owner details → provision → sets the `mb_dev_operator` dev-context cookie → `/onboarding`.
  - **Onboarding → bookable (agent):** the wizard now collects a price + duration per starter
    activity and, in the same tenant tx, sets `visible_online`, creates a "Standard" Rate, and
    generates 21 days of timeslots (reusing core `generateTimeslots`) — so a fresh tenant has a
    genuinely bookable storefront. (Wizard→storefront click-through = remaining browser pass.)
  - **Per-tenant white-label (agent + me, D-033):** the web `getBrand()` is now async and
    resolves from `GET /api/operator/public` (not env), with a safe fallback; the root layout
    title became an async `generateMetadata()` off the operator brand. Live: storefront title +
    header render "Lake Sonoma Marina", and the old env default appears nowhere.
  - **Fresh-tenant sweep (me):** provisioned an empty operator and smoked it — **all admin routes
    render 200 with graceful empty states** (dev-context cookie genuinely switches tenant). Test
    operators cleaned up (cascade delete confirmed).
  - Built by 3 lean parallel Sonnet agents + my foundation + integration. typecheck 9/9; admin
    build green (27 routes incl. `/signup`); web build green. **Phase 2 complete.** Held locally,
    not pushed (Vercel quota).
- **2026-06-06** — **Phase 1 live verification + zero-broken-routes (task 1.8).** Stood the
  full stack up against Neon and verified the cockpit end-to-end — the first time the frontend
  has actually been *run*, not just compiled.
  - **Admin→API seam (D-029) fixed + proven:** the tenant middleware only resolved
    `x-operator-slug`/Host, so every admin→API call 400'd. Added a validated `x-operator-id`
    server-to-server path (**D-030**); then smoked all five admin-consumed endpoints live →
    200, plus a real gift-card **write** (issued by `dev-owner`) and correct negatives
    (404 bad tenant, 401 no staff). Re-seeded the Neon dev tenant to pick up the `dev-owner`
    OWNER staff (the 06-04 re-seed gap).
  - **Isolation re-verified live 8/8** after the middleware change — no regression.
  - **Touched API suites live: 35/35** (gift cards, resources, waiver templates, by-location,
    transactions, POS).
  - **Server-render smoke: every route 200.** Admin **21/21** routes and web **all** routes
    (incl. a real activity detail page) render live. The smoke caught **two pre-existing 500s**
    (latent because the FE was never run) — `/activities` (passed `cell` functions to a client
    DataTable) and `/settings` (mapped a `'use client'` export from the server) — both **fixed**
    (D-031). Also fixed `ResourcesClient` importing the shell barrel (Clerk server-only).
  - **Customer login loop verified live:** request → `devCode` (Resend didn't deliver → the
    D-017 graceful fallback the UI surfaces) → verify → 7-day token, single-use enforced.
  - Final: typecheck 9/9, both apps build, all servers torn down (RAM-tight machine).
  **Phase 1 (Wire the Cockpit) is complete.** Held locally, not pushed (Vercel quota).
- **2026-06-06** — **Cockpit sweep: 5 backend pillars surfaced in the admin UI (Phase 1, tasks 1.2–1.7).**
  Built the admin UI for every shipped-but-unreachable backend capability, via a new shared
  server-to-server API client (`apps/admin/lib/apiClient.ts`, D-029) so the money/capacity
  invariants stay single-sourced in the live-tested API rather than duplicated in the admin.
  - **Gift Cards** (`/giftcards` + nav): KPI tiles + table; issue, redeem, adjust (signed
    delta + reason), void/reactivate, balance/ledger lookup — over `/api/giftcards`.
  - **Resources/Assets** (`/resources` + nav): the moat, made visible — CRUD with
    seat_capacity/quantity/out_of_service, allocation mode (SHARED_SEATS vs WHOLE_UNIT charter),
    activity assignment, derived availableQty; writes via `/api/resources`, select options via
    the existing direct-DB loaders.
  - **Waiver Templates** (Settings → Waivers): version history + signature counts, publish a
    new (immutable) version, activate — `operator:manage`-gated, read-only for others.
  - **Reports**: two new tabs — **By Location** (item-level gross roll-up + chain total) and
    **Accounting** (payment journal keyed by cash date + per-tender reconciliation), both
    fetched from `/api/reports/*` and CSV-exportable through the existing export path.
  - **POS gift-card tender**: a "Gift card" tender that applies stored value to the order's
    balance via `/api/payments/gift-card` (order created then tendered; COMPLETED status, no
    invalid PENDING).
  Integration fixes I made: invalid `'PENDING'` OrderStatus → `'COMPLETED'` (schema has no
  PENDING); a client component (`ResourcesClient`) importing the shell barrel (pulls Clerk
  server-only) → import the `DataTable` leaf instead (the known client/server-boundary gotcha).
  Verified: **typecheck 9/9 green**, **admin production build green (26 routes)**, web build
  green. Built by 5 lean parallel Sonnet agents + a central integration pass. Live API-seam
  verification is task 1.8. Held locally, not pushed (Vercel quota).
- **2026-06-06** — **Customer email-OTP login UI — 0.7 fully ✅ (Phase 1 / cockpit, task 1.1).**
  Built the last 0.7 piece: a passwordless customer login on apps/web over the
  already-live-verified D-017 backend. New `/login` two-step screen (email → 6-digit
  code; shows the `devCode` hint in non-prod when email isn't delivered); `verifyCode`
  server action stores the signed JWT in an **httpOnly** cookie (`lib/session.ts`) and
  redirects (open-redirect-guarded `next`). The account area is now session-aware —
  "signed in as …" + sign-out, a prominent passwordless sign-in CTA, and the
  order-number+email lookup kept as a fallback with the email prefilled when signed in.
  The API client (`lib/api.ts`) gained `requestCustomerLoginCode`/`verifyCustomerLoginCode`
  and optional bearer support; `rescheduleBookingAction` now forwards the session token so
  the API authenticates identity from the verified token rather than the body email.
  **Also fixed a broken route:** the site header linked "My Booking" → `/lookup` (a 404 —
  no such page); now → `/account` + a "Sign in" link (zero-broken-routes). Verified:
  @marina/web typecheck clean + production build green (9 routes, `/login` + dynamic
  `/account`). Browser E2E batched into the Phase 1.8 verification pass. Held locally,
  not pushed (Vercel quota).
- **2026-06-05** — **Resource allocation mode: shared seating vs whole-unit charter (D-026).** Closed
  the last D-024 follow-up + a real correctness gap: with shared-seats-only, a 2-of-10-seat charter
  booking left 8 seats sellable to others for a concurrent activity → double-booking the chartered
  asset. Added `ResourceAllocationMode` enum + `Resource.allocation_mode` (migration applied live to
  Neon, additive, default SHARED_SEATS; no RLS change). WHOLE_UNIT ⇒ a booking reserves a whole unit
  regardless of party size. `getResourceConstraints` still returns `remaining` in participants so the
  guard/POS/reschedule/reads are unchanged; only the per-resource math branches. `/api/resources`
  accepts+returns `allocationMode`. +1 live case (whole-unit charter: one 2-seat booking → remaining 0,
  second refused). api **166 → 167**; grand total **243 → 244 green**. typecheck 9/9. **Resource pillar
  complete.** Held locally, not pushed (Vercel quota).
- **2026-06-05** — **Resource overlay extended to the month-range calendar (D-024 cont).** Closed the
  last availability follow-up: `getRangeAvailability` now folds each slot's EFFECTIVE remaining
  (own-capacity vs shared-resource pool, whichever is tighter) into the day rollup, so the month
  calendar's traffic light goes red on a day whose backing asset is fully committed even when the
  slot's own seats are unsold. Reuses the same `getResourceConstraints` batch primitive; no-op for
  activities with no resource. +1 live case (a resource-committed day reads red with 0 effective
  remaining despite 20 own seats free). api **165 → 166**; grand total **242 → 243 green**. typecheck
  9/9. Only the whole-unit/exclusive-charter allocation policy remains as a D-024 follow-up. Held
  locally, not pushed (Vercel quota).
- **2026-06-05** — **Bugfix: order-number sequencing collided for same-day future bookings (D-025).**
  `createBooking` computed the per-service-day sequence by counting orders *created* in the slot's
  (future) calendar day — ~0 for any future slot, so every booking for a given future date got
  sequence `001` and the second collided on the `order_number` unique constraint (P2002). Fixed to
  count orders sharing the day's prefix (`orderNumberPrefix`, factored out in `@marina/core`), plus a
  bounded retry on the residual concurrent race. POS numbering (by creation day) unaffected. +1 live
  case (two bookings on one future day → distinct increasing sequences). core 69/69; api **164 → 165**;
  grand total **241 → 242 green**. typecheck 9/9. Held locally, not pushed (Vercel quota).
- **2026-06-05** — **Resource-backed availability — the moat (Phase 3, D-024).** Made capacity
  derive from shared physical assets: a `Resource` backing more than one activity is now one pool, so
  booking it for one activity removes that capacity from every sibling for the OVERLAPPING time. New
  `services/resource-availability.ts` is the single overlap-aware primitive both paths use. Contention
  is OrderItem-level (each item's own slot start + its own `Rate.duration_minutes` — duration lives on
  Rate, not Activity, corrected mid-build), seat-pool sized as `seat_capacity × (quantity −
  out_of_service_qty)`. Enforced in `createBooking` (refuse `INSUFFICIENT_RESOURCE_CAPACITY` 409) and
  overlaid on `getDayAvailability` (lowers `capacityRemaining`, sets a new `resourceConstrained` flag,
  drives the traffic light off effective remaining). An activity with no active resource returns
  `remaining: null` → a no-op (zero behaviour change for non-resource operators). No schema/RLS change.
  New live suite **6/6** (full pool when empty, unbacked→null, A's booking drains the overlapping B
  slot while a non-overlapping B slot stays full, B-booking refused with the resource as sole binding
  limit, day-availability resourceConstrained+0+FULL, batched lookup keyed by slot). api **156 → 162**;
  grand total **233 → 239 green** (core 69 + isolation 8 + api 162). typecheck 9/9. Follow-ups:
  reschedule/POS enforcement, whole-unit allocation policy, month-range overlay. Held locally, not
  pushed (Vercel quota).
- **2026-06-05** — **Resource enforcement extended to POS + reschedule (D-024 cont).** Closed two of
  the D-024 follow-ups so a shared asset can't be over-allocated through any write path. POS
  `POST /api/pos/sale`: the pool check runs IN the write transaction, per booking line, so multiple
  lines in one sale that draw on the same asset accumulate (each line sees the items the prior lines
  just created). `rescheduleBooking`: checks the pool at the NEW time using the item's rate duration,
  excluding the item itself (new `excludeOrderItemId` on the primitive) so a move into an overlapping
  window isn't blocked by the booking's own current slot. +2 live cases (POS sale refused 409 with the
  resource as sole binding limit; reschedule into a committed window refused, item stays put). api
  **162 → 164**; grand total **239 → 241 green**. typecheck 9/9. (Surfaced a separate latent bug: the
  createBooking order-number sequence counts orders by `created_at` within the SLOT's future day, so
  two bookings for the same future service date collide on `order_number` — tracked next.) Held
  locally, not pushed (Vercel quota).
- **2026-06-05** — **Resource/asset catalog CRUD + activity assignment (Phase 3, D-023).** Staff CRUD
  `/api/resources` + the `ActivityResources` m2m assignment (seat_capacity/quantity/out_of_service_qty,
  derived availableQty, tenant-validated refs). Pure code slice — `Resource` was already in schema +
  rls.sql. Live-verified **7/7**; api **149 → 156**. Held locally, not pushed (Vercel quota).
- **2026-06-05** — **Versioned waiver template management (1.9 / go-live, D-022).** Waiver
  templates were seed-only with no management API. Added staff management designed around audit
  integrity: `GET /waivers/templates` (list versions + each one's `signatureCount`, order:read),
  `POST /waivers/templates` (publish a NEW version, operator:manage), `POST /waivers/templates/:id/activate`
  (operator:manage). **`template_html` is immutable per version** — every signature references the
  exact version signed, so "editing" creates a new Waiver row rather than mutating signed legal
  text; old versions are retained forever. Exactly one version is active at a time, switched
  transactionally (publish-with-activate deactivates the prior; `activate:false` stores a draft).
  Gated at `operator:manage` (a MANAGER gets 403, verified). Advances the "waivers legally sound +
  audit trail" go-live item. New live suite **5/5** (lists seed active; publish-new-active
  deactivates prior + public /active follows; draft leaves active untouched; activate switches;
  401-anon + 403-MANAGER). api **144 → 149**; grand total **221 → 226 green** (core 69 + isolation
  8 + api 149). typecheck 9/9. Held locally, not pushed (Vercel quota).
- **2026-06-05** — **Accounting transactions export — backend (Phase 3, D-021).** Added the
  payment journal a bookkeeper imports into QuickBooks/Xero: `GET /api/reports/transactions`
  (+ `.csv`), report:read-gated, date-range filtered (reports route, no schema change). One row
  per Payment, **net of its own refunds** (`gross − refunded`; the schema nets refunds into the
  originating Payment per D-016), with method/processor/txn-id/order#/customer/manually-keyed.
  **Keyed by `processed_at`** (cash-movement date) rather than order creation — that's what
  reconciles to a bank statement. Includes a per-tender breakdown (CARD/CASH/GIFT_CARD/COMP →
  count/gross/refunded/net) + grand total, row sums equal totals by construction. It's a flat
  journal, not GL-mapped double-entry (that's operator-specific, a later integration); the CSV is
  the universal import shape. New live suite **3/3** (partially-refunded CARD + CASH on one order →
  exact per-row net, row-sum == per-method-sum == totals invariant, 401-without-staff, CSV TOTAL
  line). api **141 → 144**; grand total **218 → 221 green** (core 69 + isolation 8 + api 144).
  typecheck 9/9. Held locally, not pushed (Vercel quota).
- **2026-06-05** — **Multi-location roll-up reporting — backend (Phase 3, D-020).** Started the
  multi-location dashboards/roll-up Phase-3 item (the core D-001/D-002 differentiator) backend-first
  by extending the reports route: `GET /api/reports/by-location` (+ `.csv`), report:read-gated,
  date-range filtered. Attribution is **item-level** — each booking line maps to its activity's
  location with gross = `unit_price_cents × quantity` (the only money figure unambiguously tied to
  one site; an order can span locations, and order-level tax/tip/fees aren't split per location, so
  those stay on `/revenue`). Returns per-location bookingCount/totalQuantity/grossCents + a chain
  roll-up total whose figures equal the sum of the location rows by construction (a tested
  invariant); activities with no location land under `unassigned`; CANCELLED excluded. No schema
  change (Location already sits between Operator and Activity). New live suite **3/3** (two fresh
  locations → exact per-location gross/qty, row-sum == total invariant, 401-without-staff, CSV
  carries the TOTAL row). api **138 → 141**; grand total **215 → 218 green** (core 69 + isolation 8
  + api 141). typecheck 9/9. Admin dashboards + per-location filtering of the other reports are
  follow-ups. Held locally, not pushed (Vercel quota).
- **2026-06-05** — **Reminder sweep + POS-sale confirmation — 1.7 fully ✅ (D-019).** Closed the
  two 1.7 follow-ups. **Reminders:** no standing job runner (ARCHITECTURE § 4 defers Redis/BullMQ)
  — instead an idempotent `sendDueReminders` sweep finds every UPCOMING booking whose timeslot is
  within a look-ahead window (`leadHours`, default 24) and hasn't been reminded, sends each, and is
  exposed at `POST /jobs/reminders` for any cron to ping. Idempotency is a new nullable
  `Order.reminder_sent_at` column (migration `20260605150000_order_reminder_sent_at`, additive —
  applied live, no RLS/grant change): a reminded booking is never re-selected, and a booking is
  stamped once *dispatched to the provider* (delivered OR provider-error) so a flaky tick can't
  retry-storm. The sweep loops operators through the RLS-scoped `forOperator` client (only the
  operator *list* uses adminPrisma — the audited platform path). `/jobs` is mounted OUTSIDE the
  tenant middleware (like `/webhooks`) and authed by a shared `JOBS_SECRET` (`Authorization: Bearer`
  or `x-jobs-secret`), open in non-prod / fail-closed in prod (D-017 posture). **POS-sale
  confirmation:** `POST /api/pos/sale` now fires `sendBookingConfirmation` (fire-and-forget,
  `isEmailConfigured()`-guarded) for a real customer email on a booking sale — synthetic
  `@pos.local` walk-in addresses are excluded (here and in the reminder selection); no staff alert
  (a POS sale is made by staff, so it'd be noise). New live suite **4/4** (in-window booking
  stamped; far-future + CANCELLED untouched; idempotent re-run; HTTP open-in-dev + JOBS_SECRET 401/200).
  Added `JOBS_SECRET` + `RESEND_FROM_EMAIL` to `.env.example`. api **134 → 138**; grand total
  **211 → 215 green** (core 69 + isolation 8 + api 138). typecheck 9/9. Held locally, not pushed
  (Vercel quota).
- **2026-06-05** — **Gift-card management: ADJUST + reversible void (D-018).** Wired the last
  modeled-but-unused gift-card ledger type (`ADJUST`) and the freeze controls — finishes
  gift-card management (issue → tender → refund → **correct/void**). No schema change (enum +
  `is_active` already existed); pure service + route + live-test. `adjustGiftCardBalance` applies
  a signed delta with a required reason and a signed `ADJUST` ledger row — a **negative** delta
  reuses the overspend-safe conditional decrement so a correction can never go below zero
  (`ADJUST_BELOW_ZERO`). `voidGiftCard` freezes a card (`is_active=false`, redeem + tender already
  guard on it) while **preserving the balance** (no value destroyed), and `reactivateGiftCard`
  restores it — each writes a zero-amount `ADJUST` marker so the ledger-sums-to-balance invariant
  holds. Three new staff endpoints (`POST /giftcards/:code/adjust · /void · /reactivate`) gated at
  **`order:refund`** (money-correction tier, above the `order:write` STAFF use for redeem) — a
  STAFF-role identity gets 403, verified live. New live suite **9/9** (adjust up/down + signed
  entries, below-zero + empty-reason refused, HTTP adjust 200 + 403-for-STAFF + 401-no-identity,
  void freezes/blocks/double-void, reactivate + double-reactivate + re-spend; ledger-sum invariant
  asserted throughout). api **125 → 134**; grand total **202 → 211 green** (core 69 + isolation 8
  + api 134). typecheck 9/9. Held locally, not pushed (Vercel quota).
- **2026-06-05** — **Customer self-service gift-card tender (2.3 complete).** With customer
  auth in place (D-017), added `POST /api/payments/customer/gift-card`: token-gated, and a
  customer may pay down ONLY their own order (ownership checked against the token's email; a
  mismatched/other-customer token 404s without leaking). Reuses the same atomic, overspend-safe
  `applyGiftCardToOrder` as the staff endpoint; the ledger entry is attributed to
  `customer:<email>`. Live 3/3 (401 without token, cross-customer 404 + balance untouched,
  owner pays down own order). api **122 → 125**; grand total **199 → 202 green**. typecheck 9/9.
  Closes the customer-checkout follow-up flagged in D-015. Held locally, not pushed.
- **2026-06-05** — **Customer email-OTP auth — backend (0.7, D-017).** Passwordless guest
  login: `CustomerOtp` model (sha256 of the code only, 10-min expiry, attempt cap; migration
  `20260605140000_customer_otp` applied live + RLS/grants). Service `customer-auth.ts`:
  `requestLoginCode` (crypto 6-digit, invalidates prior codes, best-effort email with a
  non-prod `devCode` fallback when delivery doesn't happen), `verifyLoginCode` (single-use,
  expiry + brute-force cap → issues an **HS256 JWT** via `hono/jwt`), `verifyCustomerToken`.
  Routes: public `POST /api/auth/customer/request` + `/verify`. Wired into self-reschedule
  (a verified token's email is the identity; body email now optional, can't be spoofed).
  Secret from `CUSTOMER_AUTH_SECRET` (fails closed in prod, dev fallback otherwise). **Bug
  caught + fixed while testing:** the wrong-code attempt increment shared the rejection's
  transaction, so the `throw` rolled it back and the brute-force cap never persisted — moved
  the increment to its own committed tx. Live suite 5/5 (devCode issuance, wrong-code 401 +
  attempt bump, correct-code → verifiable single-use token, token-authenticated reschedule,
  cross-email rejection). api **117 → 122**; grand total **194 → 199 green**. typecheck 9/9,
  build 3/3. Remaining for 0.7: the customer web login UI. Held locally, not pushed.
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
