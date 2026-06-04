# Handoff — next session start here

> Living handoff for whoever (human or agent) picks up the Marina Booking Platform
> next. Keep it short and current; the durable detail lives in the other `docs/`.

Local clone: `C:\Users\Jeff\marina-booking-platform`. Everything is pushed to `main`;
pushes auto-deploy to Vercel.

**Read first (the repo is the shared brain):** [`AGENTS.md`](../AGENTS.md), then
[`docs/CONTEXT.md`](CONTEXT.md), [`docs/ARCHITECTURE.md`](ARCHITECTURE.md),
[`docs/DECISIONS.md`](DECISIONS.md) (D-001…D-009), [`docs/ROADMAP.md`](ROADMAP.md)
(live status board), [`docs/DEPLOY.md`](DEPLOY.md).

## What it is

Multi-tenant white-label SaaS to beat Singenuity. Seed client = owner's Lake Sonoma
Marina. Architected for complex customers (chains, many activity verticals
— boat / watercraft / patio / lodging / **tour** / class / event / equipment — RBAC,
integrations). Owner wants it fully vibe-coded with minimal input, rock-solid enough
to sell.

## Current state (verified green)

Phase 0 + Phase 1 build sweep complete (223 files). As of last verification:

- Full monorepo **typecheck = 0 errors**.
- **Tests:** `@marina/core` 69/69 pass. `@marina/database` cross-tenant isolation
  suite (8 cases) is now wired into the test pipeline; it **skips** when
  `DATABASE_URL` is unset and **auto-activates** once the DB is connected.
- **Builds:** web (7 routes) + admin (21 routes) + api all build.

Monorepo: pnpm + turbo. Packages: `types`, `database` (20-model Prisma + Postgres RLS
+ `forOperator`/`withTenant` tenant client + LSRA seed), `auth` (RBAC), `core`
(pricing/availability/zod), `ui`, `emails`. Apps: `api` (Hono — all routers wired in
`app.ts`), `web` (Next 14 customer portal), `admin` (Next 14 operator app).

## ⚠️ Critical: it has NOT run against a live database yet

UI shows graceful "not connected" states. The #1 unblocker is a **Neon Postgres**
connection string from the owner (`DATABASE_URL` + `DIRECT_URL` → `.env`, gitignored).
See `.env.example` for the exact shape of every secret.

## Next steps, in order

1. **When the Neon string arrives:** `pnpm db:migrate` → `pnpm db:rls` →
   `pnpm db:seed`, then start the API (`pnpm --filter @marina/api dev`) + apps and
   smoke-test the booking flow end-to-end.
2. **Prove tenant isolation:** with the DB connected, `pnpm --filter @marina/database
   test` now runs the cross-tenant isolation suite for real (roadmap 0.8) — operator A
   must not see/write B. It's written and waiting on the DB.
3. **Clerk** (real auth, replaces the `x-dev-staff-id` header shim + admin dev fallback
   to operator `lsra`/OWNER) and **Square sandbox** keys (charge a test booking),
   **Resend** key (send confirmation email).

## Things only the owner / a browser can do (blocked-on-owner)

These need account dashboards — see `docs/BROWSER-TAKEOVER.md` for a copy-paste prompt:
Neon connection string · Vercel project import + env vars · Clerk keys · Square
sandbox keys · Resend key. Build everything against sandboxes/free tiers; flag exactly
when each is needed.

## Gotchas already solved (don't regress)

- `square` must be **v44+** (new `SquareClient` API).
- Next apps need `webpack resolve.extensionAlias` `.js`→`.ts` to consume the shared TS
  packages.
- Client components must import shell **leaf files**, not the server-only barrel.
- `noUncheckedIndexedAccess` is off (D-009).
- Prisma `create` calls need explicit `operator_id`.
- Migrate `package.json#prisma` → `prisma.config.ts` before Prisma 7 (deprecation
  warning, non-blocking for now).

## Working style

Commit + push frequently (Vercel auto-deploys); update `docs/ROADMAP.md` changelog and
`docs/DECISIONS.md` as you go; owner is on a budget so default to lean unless they
explicitly ask for a big agent sweep. End commit messages with
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
