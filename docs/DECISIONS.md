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
