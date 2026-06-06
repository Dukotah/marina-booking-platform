# Vision

> The founder's read of what this is, the bar for "fully functional," and what
> winning looks like beyond functional. Deep technical context lives in
> [`docs/`](docs/) (CONTEXT, ARCHITECTURE, DECISIONS). This file is the why.

## What this is

A **multi-tenant, white-label SaaS booking platform** for marinas and
outdoor-recreation operators — built to replace the legacy incumbent
(**Singenuity**) and be sold to real, paying operators. Customer zero is the
owner's own **Lake Sonoma Marina** (19 activities), used to battle-test it in
the real world. It is deliberately architected for operators *more complex than
us*: multi-location chains, many verticals (lodging/tours/classes/events, not
just boats), big staff with granular RBAC, and channel/accounting integrations.

## Who it's for

- **End customers** book activities on a fast, beautiful, fully white-labeled
  storefront that looks like *the operator's* product — never ours.
- **Operators & their staff** run the whole business from one app, one login,
  with role-filtered views: a dashboard, a visual Gantt manifest, POS, CRM,
  reports, and self-serve setup — the opposite of Singenuity's three-app,
  no-dashboard, 404-strewn experience.
- **The platform owner** (us) sells tenancy and earns subscription + payment
  margin.

## Honest read of the state (2026-06-06)

This is a **mature backend with an under-wired cockpit.**

- **Backend: production-grade.** 26 logged decisions. Three-layer tenant
  isolation (operator_id FK + Postgres RLS via a non-bypass role + tenant-composite
  FKs), provably airtight (8/8 live isolation suite). Money is integer-cents and
  ledgered (gift cards are a signed, reconcilable, overspend-safe ledger).
  The real moat — **resource-backed availability** (a shared physical asset
  constrains every activity it backs, with shared-seat vs whole-unit-charter
  modes) — is built and live-verified. ~244 tests green; typecheck 9/9.
- **Frontend: broadly built, narrowly wired, never driven.** Both Next apps
  exist with most pages (customer: catalog → activity → checkout → confirmation →
  account; admin: dashboard, manifest, calendar, orders, activities wizard,
  customers, POS, reports, settings, staff). They typecheck and build — but have
  **not been exercised end-to-end in a browser**, and a large share of the proven
  backend has **no UI at all**: gift cards, resources/assets (the moat!), waiver
  template management, multi-location roll-up reporting, accounting export, and
  the customer email-OTP login.
- **Front door: missing.** New operators cannot sign themselves up; tenancy is
  seed-only today. The actual SaaS business model (self-serve onboarding +
  per-tenant billing) is not yet built.
- **Go-live: owner-blocked in places.** Live Stripe keys, Clerk dashboard setup,
  deploy/monitoring/backups, and a legal waiver review need the owner.

## The bar for "fully functional"

A product is fully functional when an operator we've never met can:

1. **Sign up**, brand their storefront, add a location + activities/rates, and go
   live without us touching a database.
2. **Take real bookings** end-to-end on a storefront that looks like theirs:
   browse → pick date/time/rate → checkout (card, gift card, promo) → waiver →
   confirmation → reminder.
3. **Run their operation** from the admin: see the dashboard + Gantt manifest,
   manage orders (cancel/refund/reschedule), sell at the POS, manage customers,
   gift cards, resources, staff/RBAC, and pull reports + accounting exports.
4. **Trust it with money and PII** — tenant isolation holds, payments/refunds are
   correct and reconcilable, waivers are legally sound with an audit trail, and
   there are zero broken routes.

Every backend capability that exists must be reachable and usable from the UI.
"Built but unreachable" does not count as functional.

## What winning looks like (beyond functional)

- **It out-demos Singenuity in 60 seconds.** One login, a real dashboard, a
  color-coded visual manifest, zero broken pages, fully the operator's brand.
- **An operator onboards in under 2 hours, unaided**, and says it's obviously
  better than what they had.
- **It feels fast and solid** — LCP < 1.5s, graceful empty/error states
  everywhere, mobile-first (>60% of bookings are mobile).
- **The moat is visible**: shared-asset scheduling that legacy per-activity tools
  simply cannot express, surfaced clearly in both the booking flow and admin.
- **We can sell it** — self-serve signup, per-tenant billing, and the trust
  story (isolation, money correctness, compliance) all hold up to scrutiny.

## Operating principles

1. **Functional is the floor.** Surface and polish until it's a product, not a
   demo.
2. **The repo is the brain.** Decisions → [`docs/DECISIONS.md`](docs/DECISIONS.md).
   Plan → [`ROADMAP.md`](ROADMAP.md). Work → [`TASKS.md`](TASKS.md). Log →
   [`PROGRESS.md`](PROGRESS.md).
3. **No broken commits.** Build passes and tests are green before any task is
   done.
4. **Multi-tenant always; money and isolation are sacred** (AGENTS.md rules).
5. **Leave it better than I found it**, every pass.
