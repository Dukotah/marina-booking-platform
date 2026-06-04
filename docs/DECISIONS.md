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
