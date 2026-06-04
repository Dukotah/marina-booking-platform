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
| 0.2 | Monorepo scaffold (Turborepo + pnpm via corepack) | ⬜ |
| 0.3 | Prisma schema w/ multi-tenant hardening (Operator, Location, Activity+config, Rate, Timeslot, Resource, Order, OrderItem, Payment, Customer, Role/Permission, Integration, Waiver) | ⬜ |
| 0.4 | Postgres RLS policies + tenant-scoped Prisma client | ⬜ |
| 0.5 | Neon dev database connected | ⏸️ (needs connection string) |
| 0.6 | Seed script — Lake Sonoma Marina (19 activities, rates, fees, policies) | ⬜ |
| 0.7 | Auth + RBAC (Clerk operators/staff, magic link customers) | ⏸️ (needs Clerk keys) |
| 0.8 | Cross-tenant isolation tests (must fail to access other tenants) | ⬜ |

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
