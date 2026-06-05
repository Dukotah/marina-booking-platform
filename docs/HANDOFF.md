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

Phase 0 + Phase 1 build sweep complete (223 files). **Now live against a real Neon
database.** As of last verification:

- Full monorepo **typecheck = 9/9**, **build = 3/3** (web + admin + api).
- **Database is LIVE:** Neon Postgres (US-West) connected; migration `init` applied;
  RLS applied; LSRA seeded (operator `lsra`, 19 activities). A dedicated NOBYPASSRLS
  `app_user` role (provisioned by `pnpm db:approle`) is what tenant queries connect
  through — required because Neon's `neondb_owner` has BYPASSRLS (see D-010).
- **Tests:** `@marina/core` 69/69. `@marina/database` cross-tenant isolation suite runs
  **live against Neon: 8/8** (D-010 FK-attach gap closed by 0.13 / D-011 — tenant-composite
  FKs; the previously-skipped attach case is un-skipped and passing).
- Secrets live in `.env` (gitignored). `DATABASE_URL`/`DIRECT_URL` (owner) +
  `APP_DATABASE_URL`/`APP_DB_PASSWORD` (app_user) are set.

Monorepo: pnpm + turbo. Packages: `types`, `database` (20-model Prisma + Postgres RLS
+ `app_user` role + `forOperator`/`withTenant` tenant client + LSRA seed), `auth`
(RBAC), `core` (pricing/availability/zod), `ui`, `emails`. Apps: `api` (Hono), `web`
(Next 14 customer portal — live at marina-web-blond.vercel.app), `admin` (Next 14
operator app — Vercel deploy currently failing, see below).

## Reproduce the live DB from scratch

`pnpm db:migrate` → `pnpm db:rls` → `pnpm db:approle` → `pnpm db:seed`. All need the
`.env` values exported (the scripts read `process.env`; there is no dotenv autoload).

## Next steps, in order

1. **Wire Clerk (0.7)** — both keys are now in `.env` (`CLERK_SECRET_KEY` filled this
   session). Build the Clerk middleware + sign-in/sign-up pages and replace the
   `x-dev-staff-id` dev shim end-to-end (api `requireStaff`, admin `lib/session`). Do
   NOT add Clerk keys to Vercel until those pages exist or the admin app will bounce to a
   nonexistent login.
2. **Square sandbox keys** — developer.squareup.com was blocked for the browser agent;
   create the app + fill `SQUARE_*` to charge a test booking (1.5).
3. **marina-admin Vercel runtime** — build is fixed and it deploys; it needs the DB env
   vars set on the Vercel project (it queries the DB directly, D-007). Until then it
   shows a graceful "Live data unavailable" notice (not a crash). See
   `docs/BROWSER-TAKEOVER.md` → "set marina-admin DB env vars". marina-web is already live.
4. Smoke-test the full booking flow end-to-end once Clerk + Square are in.

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
- Prisma **top-level** `create` calls need explicit `operator_id`; but **nested** creates
  under a tenant-composite parent (e.g. `order.create({ items: { create: [...] } })`)
  must NOT pass `operator_id` — Prisma derives it from the parent (D-011). Typecheck
  catches violations.
- Migrate `package.json#prisma` → `prisma.config.ts` before Prisma 7 (deprecation
  warning, non-blocking for now).

## Working style

Commit + push frequently (Vercel auto-deploys); update `docs/ROADMAP.md` changelog and
`docs/DECISIONS.md` as you go; owner is on a budget so default to lean unless they
explicitly ask for a big agent sweep. End commit messages with
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
