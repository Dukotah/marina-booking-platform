# Architecture

This describes *how* the platform is built. It is driven by the four growth
requirements in [`CONTEXT.md`](CONTEXT.md): multi-location chains, many activity
verticals, big staff/RBAC, and channel/integrations. Decisions and their rationale
are logged in [`DECISIONS.md`](DECISIONS.md).

## 1. Tenant isolation (the most important section)

The platform is **multi-tenant from day one**. Getting this wrong is the single
biggest risk, so it is enforced in three layers:

1. **Schema** — every tenant-owned table carries `operator_id` (non-null, indexed,
   FK to `Operator`). Sub-resources also carry `location_id` where relevant.
2. **Database (defense in depth)** — PostgreSQL **Row-Level Security (RLS)**
   policies on tenant tables, keyed off a session variable
   (`app.current_operator_id`) set per request. Even a buggy query cannot cross
   tenants.
3. **Application** — all data access goes through a tenant-scoped data layer that
   injects `operator_id` from the authenticated session. No raw cross-tenant
   queries outside an explicit, audited "platform admin" path.

**Rule for agents:** never write a query against a tenant table without an
`operator_id` scope. There are tests that assert cross-tenant access fails.

## 2. Multi-tenant addressing

- Each operator gets `{slug}.app-domain.com` (subdomain) and may map a custom
  domain. The host header resolves the tenant before auth.
- Full white-label: tenant branding (logos, colors, name) is loaded per host. No
  platform branding ever renders on customer-facing pages.

## 3. Data model principles (extensibility)

To support many verticals without rewrites:

- **Activity is generic, not boat-specific.** `category` (BOAT | WATERCRAFT | PATIO
  | LODGING | TOUR | CLASS | EVENT | EQUIPMENT | OTHER) + a flexible `config` JSON
  for vertical-specific fields. Core booking logic (rates, timeslots, capacity,
  orders) is category-agnostic.
- **Location** sits between Operator and Activity. An operator with one site has a
  single default location; chains have many. All reporting can roll up by location.
- **Resources** (physical assets — boats, rooms, equipment) are modeled separately
  from Activities so capacity can be backed by real inventory when needed.
- **RBAC**: Operator → Roles (Owner, Admin, Manager, Staff, Guide) → granular
  permissions. Staff are scoped to one or more locations.
- **Integrations** are per-operator config records, not hard-coded — so OTAs,
  accounting, CRM, and pixels can be added without schema churn.

The baseline Prisma schema lives in `CLAUDE_CODE_START_HERE.md` and will be migrated
into `packages/database` with the multi-tenant hardening above (Location, Role,
Permission, Resource, Integration, RLS) added.

## 4. Stack

| Layer | Choice |
|---|---|
| Monorepo | Turborepo + pnpm (via corepack) |
| Customer portal | Next.js 14 App Router, TypeScript, Tailwind, shadcn/ui |
| Admin + POS | Next.js 14 App Router (same app, role-filtered) |
| API | Node.js + Hono (Bun optional later) |
| Database | PostgreSQL + Prisma ORM, RLS for tenant isolation |
| Cache / jobs | Redis + BullMQ (added when needed, not MVP day 1) |
| Payments | Square SDK (sandbox first), Stripe optional |
| Email | Resend + React Email |
| SMS | Twilio |
| Auth | Clerk (operators/staff) + magic link (customers) |
| Storage | Cloudflare R2 |
| Deploy | Vercel (web) + Railway/Render (API) |

## 5. Monorepo layout (target)

```
marina-booking-platform/
├── apps/
│   ├── web/        # Customer booking portal (Next.js)
│   ├── admin/      # Operator dashboard + POS (Next.js)
│   └── api/        # REST + WebSocket (Hono)
├── packages/
│   ├── ui/         # Shared shadcn-based component library
│   ├── database/   # Prisma schema + migrations + tenant-scoped client
│   ├── types/      # Shared TypeScript types
│   ├── auth/       # Auth + RBAC helpers
│   └── emails/     # React Email templates
├── docs/           # The shared brain (this folder)
├── turbo.json
└── package.json
```

## 6. Dev environment reality (this machine)

Checked 2026-06-04 on the owner's Windows 11 machine:

- ✅ Node v24.16.0, npm 11.13.0, git 2.54 — present.
- ⚠️ **pnpm not installed** → use `corepack enable && corepack prepare pnpm@latest --activate`.
- ⚠️ **Docker not installed** → do **not** assume local containers. Use a hosted
  **Neon** Postgres (free tier) for dev; Redis added later via a hosted free tier
  (Upstash) only when jobs/caching are actually needed.
- Shell is PowerShell; a Bash tool is also available. Paths are Windows-style.

## 7. Secrets / external accounts needed (deferred until go-live)

Build runs against sandboxes/free tiers first. These need the owner eventually:
Neon connection string, Clerk keys, Square sandbox→production keys, Resend API key,
Twilio (later), Cloudflare R2, deploy accounts. Tracked in `ROADMAP.md`.
