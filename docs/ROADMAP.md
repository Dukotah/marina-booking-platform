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
| 0.5 | Neon dev database connected + first migration run | ⏸️ (needs connection string) |
| 0.6 | Seed script — Lake Sonoma Marina (19 activities, rates, fees, waiver, config) | ✅ (written; runs once DB connected) |
| 0.7 | Auth + RBAC (Clerk operators/staff, magic link customers) | ⏸️ (needs Clerk keys) |
| 0.8 | Cross-tenant isolation tests (must fail to access other tenants) | ⬜ |
| 0.9 | Auth/RBAC package (@marina/auth) — permission checks, AuthContext | ✅ |
| 0.10 | API skeleton (Hono) — tenant-resolution middleware, RLS-scoped client per request, dev auth shim, catalog route; boots + tenant guard verified | ✅ |
| 0.11 | Customer portal shell (apps/web, Next 14 + Tailwind) — catalog page wired to API, white-label brand var, graceful no-DB state | ✅ |
| 0.12 | Admin dashboard shell (apps/admin, Next 14 + Tailwind) — dashboard-first KPI layout + nav | ✅ |

## Phase 1 — MVP (sellable booking core)

| # | Item | Status |
|---|---|---|
| 1.1 | Operator onboarding wizard (brand, location, first activities) | ⬜ |
| 1.2 | Activity CRUD (simplified wizard, generic categories) | ⬜ |
| 1.3 | Customer portal: catalog → date → time → rate → checkout | ⬜ |
| 1.4 | Availability calendar (color-coded) + capacity-aware time slots | ⬜ |
| 1.5 | Square payments (sandbox) | ⏸️ (needs Square sandbox keys) |
| 1.6 | Order list + detail + cancel + refund (full & partial) | ⬜ |
| 1.7 | Email confirmation + reminder (Resend) | ⏸️ (needs Resend key) |
| 1.8 | Day Gantt manifest (visual, color-coded, drag-to-reschedule) | ⬜ |
| 1.9 | Digital waiver signing + audit trail | ⬜ |
| 1.10 | Dashboard home (revenue/occupancy KPIs, alerts, upcoming) | ⬜ |
| 1.11 | Full white-label theming per tenant | ⬜ |

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
- **2026-06-04** — Frontend shells scaffolded. apps/web (Next 14, App Router,
  Tailwind): catalog page server-fetches the API by operator slug, renders
  category-grouped activity cards with from-pricing, white-label brand CSS var, and a
  graceful "DB not connected yet" state. apps/admin (Next 14): dashboard-first layout
  with KPI cards + nav (placeholders until orders API). Both typecheck clean. Added
  .gitattributes (LF normalization). Phase 0 scaffolding complete — remaining Phase 0
  items (0.5 Neon, 0.7 Clerk, 0.8 isolation tests) need owner-provided accounts.
