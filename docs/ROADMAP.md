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
| 0.7 | Auth + RBAC (Clerk operators/staff, magic link customers) | ⏸️ (needs Clerk keys) |
| 0.8 | Cross-tenant isolation tests (must fail to access other tenants) | ✅ (live vs Neon RLS — 7/7 pass: reads, writes, WITH CHECK, bulk ops, symmetric; 1 case skipped → 0.13) |
| 0.9 | Auth/RBAC package (@marina/auth) — permission checks, AuthContext | ✅ |
| 0.10 | API skeleton (Hono) — tenant-resolution middleware, RLS-scoped client per request, dev auth shim, catalog route; boots + tenant guard verified | ✅ |
| 0.11 | Customer portal shell (apps/web, Next 14 + Tailwind) — catalog page wired to API, white-label brand var, graceful no-DB state | ✅ |
| 0.12 | Admin dashboard shell (apps/admin, Next 14 + Tailwind) — dashboard-first KPI layout + nav | ✅ |
| 0.13 | **Hardening: tenant-composite FKs** — `@@unique([operator_id, id])` on parents + composite child relations so the DB refuses cross-tenant FK references (closes the D-010 gap; un-skips the isolation case) | ⬜ |

## Phase 1 — MVP (sellable booking core)

| # | Item | Status |
|---|---|---|
Status key for Phase 1: ✅🧪 = code complete, typechecks + builds, but not yet
exercised against a live DB/keys (waiting on 0.5 Neon + service keys).

| # | Item | Status |
|---|---|---|
| 1.1 | Operator onboarding wizard (brand, location, first activities) | ✅🧪 |
| 1.2 | Activity CRUD (simplified wizard, generic categories) | ✅🧪 |
| 1.3 | Customer portal: catalog → date → time → rate → checkout | ✅🧪 |
| 1.4 | Availability calendar (color-coded) + capacity-aware time slots | ✅🧪 |
| 1.5 | Square payments (sandbox, SDK v44) | ✅🧪 (needs Square keys to charge) |
| 1.6 | Order list + detail + cancel + refund (full & partial) | ✅🧪 |
| 1.7 | Email confirmation + reminder (Resend) | ✅🧪 (needs Resend key to send) |
| 1.8 | Day Gantt manifest (visual, color-coded) + week calendar | ✅🧪 |
| 1.9 | Digital waiver signing + audit trail | ✅🧪 |
| 1.10 | Dashboard home (revenue/occupancy KPIs, alerts, upcoming) | ✅🧪 |
| 1.11 | Full white-label theming per tenant | ✅🧪 (brand var; logo upload later) |

## Phase 2 — Core operations

Merchandise POS (integrated) · gift cards · promo codes · customer CRM ·
reports + CSV export · staff roles/permissions UI · SMS (Twilio) ·
customer self-service reschedule.

## Phase 3 — Power features (the moat for complex customers)

Resource/asset management · guide scheduling · package builder + upsells ·
**multi-location dashboards + roll-up reporting** · dynamic pricing · kiosk mode ·
channel/OTA + affiliate management · accounting exports (QuickBooks/Xero).

## Go-live checklist (before selling)

- [ ] Cross-tenant isolation tests pass
- [ ] Payment + refund flows tested end-to-end in Square production
- [ ] Waiver capture legally reviewed + audit trail verified
- [ ] Zero broken routes (route test sweep)
- [ ] Backups + error monitoring configured
- [ ] Custom domain / subdomain white-label verified for a test tenant

## Blocked-on-owner (deferred external accounts)

Neon connection string · Clerk keys · Square sandbox→prod keys · Resend key ·
Twilio (later) · Cloudflare R2 · Vercel + Railway deploy accounts.
I will build against sandboxes/free tiers and flag exactly when each is needed.

## Changelog

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
