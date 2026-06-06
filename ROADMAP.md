# Roadmap

> The forward plan: from current state → fully functional → polish. The granular
> backend status board + full changelog lives in
> [`docs/ROADMAP.md`](docs/ROADMAP.md); this file is the founder-level plan and is
> kept honest and current. Active task breakdown is in [`TASKS.md`](TASKS.md).

**Legend:** ⬜ not started · 🟦 in progress · ✅ done · ⏸️ blocked-on-owner

---

## Where we are

Backend is production-grade and live-verified against Neon (tenant isolation,
ledgered money, the resource-availability moat). Both Next apps build and
typecheck. The gap to "fully functional" is the **cockpit** (a lot of proven
backend has no UI and the frontend has never been driven), the **front door**
(no self-serve operator signup), and **go-live ops** (some owner-blocked).

---

## Phase 1 — Wire the Cockpit  🟦

**Goal:** every shipped backend capability is reachable and usable from a working
UI, and the existing frontend is actually exercised, not just compiled.

**Milestones**
- Customer **email-OTP login** UI (web) — flips ROADMAP 0.7 fully ✅.
- Admin **Gift Cards** page — issue / list / balance / redeem / adjust / void.
- Admin **Resources / Assets** page — CRUD, activity assignment, allocation mode
  (the moat, made visible).
- Admin **Waiver Templates** management (in Settings) — versions, publish, activate.
- **Reports**: add **By-Location** roll-up + **Accounting (transactions)** tabs
  and CSV exports.
- **POS**: gift card as a tender.
- **Verification pass**: every route renders (smoke), touched live suites green,
  no broken pages.

**Definition of done:** typecheck 9/9, all app builds green, live suites for
touched areas green, no nav item or feature dead-ends. A demo can reach every
backend capability through the UI.

## Phase 2 — The Front Door (self-serve tenancy)  ⬜

**Goal:** an operator we've never met can create their tenant and go live unaided.

**Milestones**
- Public **operator signup** → provisions an Operator + first OWNER staff + a
  default Location, wired to Clerk (behind the existing `REQUIRE_CLERK_AUTH` flag).
- **Guided first-run onboarding** (brand → location → first activity/rate →
  publish) that lands a real, bookable storefront.
- **Subdomain/tenant resolution** verified for a fresh tenant end-to-end (host →
  operator → branded storefront + admin).
- Empty-state everything: a brand-new tenant is never a broken or confusing page.

**Definition of done:** a scripted "new operator" flow goes from signup to a live
bookable activity with zero manual DB work; isolation still 8/8.

## Phase 3 — Money & Go-Live Readiness  ⬜ (partly ⏸️ owner)

**Goal:** real money flows correctly and the platform is operationally safe to run.

**Milestones**
- **Stripe live path**: 3DS/SCA handling (currently treated as decline), receipts,
  webhook reconciliation hardening. ⏸️ live keys (owner).
- **Per-tenant billing** (subscription + payment margin) — the business model.
- **Observability**: structured logging, error monitoring (Sentry-style, wired
  dark behind a DSN env), health/readiness endpoints.
- **Backups + DR** posture documented and verified on Neon.
- **Deploy** green: fix marina-admin Vercel deploy; document the deploy runbook.
  ⏸️ Vercel quota / deploy accounts (owner).
- **Legal**: waiver capture reviewed; ToS/privacy surfaces. ⏸️ (owner).

**Definition of done:** the go-live checklist in `docs/ROADMAP.md` is all green or
explicitly owner-gated with a one-line status.

## Phase 4 — Polish & Delight  ⬜

**Goal:** it feels like a premium product, not a working demo.

**Milestones**
- Performance budget met (LCP < 1.5s, mobile-first), image/asset optimization.
- Accessibility pass (keyboard, focus, contrast, aria) across both apps.
- Loading/skeleton/empty/error states audited everywhere; zero layout shift.
- Drag-to-reschedule on the Gantt manifest; richer availability visualization.
- Notifications polish (SMS via Twilio when keys land), branded email templates.
- Real white-label proof: a second demo tenant with a totally different brand.

**Definition of done:** a cold operator demo is visibly better than Singenuity on
every axis in CONTEXT.md's comparison table.

---

## IMPROVEMENTS (continuously discovered)

Ideas a sharp owner would obviously want. Promote to a phase/task when worth
building; log the meaningful build decisions in `docs/DECISIONS.md`.

- **Report logic shared in `@marina/core`.** By-location/transactions aggregation
  currently lives in the API route; the admin reads via direct DB (D-007). Extract
  the aggregation into `@marina/core` so API and admin share one source of truth
  and can't drift. (Decide when building Phase-1 reports.)
- **Auto-credit-to-gift-card on cancel** as an operator policy (D-016 deferred it).
- **Resource-aware Gantt manifest** — show shared-asset contention visually, the
  moat where operators feel it.
- **Waiver `waiver:manage` permission** so an ADMIN can manage waivers without full
  `operator:manage` (D-022 reused the config-tier perm).
- **Customer account upgrade**: magic-link (vs OTP) and a real bookings dashboard
  with self-service reschedule/cancel surfaced cleanly.
- **Bulk timeslot/seasonal scheduling** tools for operators with recurring
  calendars.
- **Per-location filtering** on the revenue/bookings reports (D-020 follow-up).
- **`reminder_attempts` retry counter** for the reminder sweep (D-019 refinement).
- **Idempotency keys on the public booking + payment endpoints** (double-submit
  safety beyond the order-number retry).
- **Rate-limit + abuse protection** on public endpoints (OTP request, booking).
- **Direct QuickBooks/Xero sync** (OAuth + GL mapping) beyond the CSV export.
- **Status/health page + uptime monitoring** for operator trust.
