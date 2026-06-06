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
  FKs; the previously-skipped attach case is un-skipped and passing). `@marina/api`
  integration suites run **live: 18/18** — booking, availability, waivers (full HTTP),
  promo, and reschedule (capacity move + `self_reschedule_hours` window + self-service HTTP
  email gate). NOTE: api suites share one Neon tenant + a singleton Prisma client, so
  `apps/api/vitest.config.ts` sets `fileParallelism:false` (must run sequentially). All
  live suites skip without `DATABASE_URL`, so plain `pnpm test` stays green (core 69 runs).
  Grand total 95.
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

> **2026-06-05 update:** the `feat/finish-mvp-buildable` branch closed the buildable
> code gaps below — customer OTP auth (0.7), Stripe 3DS (1.5), reschedule UI (2.1) — and
> a hardening pass that fixed real end-to-end bugs (nested-vs-flat order serializer, dead
> post-payment `/confirmation/<n>` redirect, browser `API_URL`, dead `/lookup` links) and
> added error boundaries + an observability seam. All code-verified (typecheck 9/9, 3
> builds, core 69/69) but NOT live-rendered — no `.env`/DB/keys on the build machine. The
> remaining work is almost entirely **provision accounts + live smoke test**, plus a few
> documented follow-ups (OTP rate-limiting, webhook idempotent-create, wire an error SDK).
> Also: a fresh clone needs `pnpm db:generate` BEFORE typecheck passes (5 Prisma-type
> errors otherwise) — worth a one-liner in setup docs.

## Next steps, in order

1. **Provision the external accounts** (the real gate to onboarding — all blocked-on-owner):
   - **Clerk** (0.7 staff, D-012) — set sign-in URLs + origins, create your staff user
     (Clerk id == `StaffMember.auth_user_id`), then `REQUIRE_CLERK_AUTH=true` on admin
     (Vercel) + API (Railway). Customer OTP auth is now built (stateless, in `apps/api`
     `routes/auth.ts` + `lib/customer-session.ts`) and needs `AUTH_SECRET` set + `RESEND_API_KEY`
     to actually email codes (works in dev via the `devCode`).
   - **Stripe test keys** (D-013) — `STRIPE_SECRET_KEY` + `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
     (+ `STRIPE_WEBHOOK_SECRET`) to charge a test booking. 3DS/SCA is now handled
     (`requires_action` → browser challenge → `POST /payments/confirm`, idempotent).
   - **Resend key** — confirmation/reminder emails + the OTP code email.
   - **marina-admin Vercel DB env vars** (D-007) — admin queries the DB directly; until set
     it shows a graceful "Live data unavailable" notice. See `docs/BROWSER-TAKEOVER.md`.
   - **`NEXT_PUBLIC_API_URL`** — now required for the browser pickers to hit the API in prod
     (falls back to `API_URL`/localhost); set it on the web Vercel project.
2. **Live smoke-test the whole flow** once the above are in — this is the big one. Browse →
   book → 3DS card → confirmation; customer OTP login → view booking → reschedule. Several
   features are `🧪` (code-verified, never live-rendered) and the order-serializer fix in
   particular wants a real render to confirm the nested→flat mapping.
3. Knock out the documented follow-ups: OTP brute-force rate-limiting, webhook
   idempotent-create for the closed-tab 3DS case, pick + wire an error-tracking SDK into
   the `captureError` seams.

## Things only the owner / a browser can do (blocked-on-owner)

These need account dashboards — see `docs/BROWSER-TAKEOVER.md` for a copy-paste prompt:
Neon connection string · Vercel project import + env vars · Clerk keys · Stripe test
keys + webhook secret · Resend key. Build everything against test/free tiers; flag
exactly when each is needed.

## Gotchas already solved (don't regress)

- Payments are **Stripe** (D-013), not Square. Card → PaymentMethod (Elements) → server
  confirms a PaymentIntent. The wire field is still named `sourceId` (now a PM id).
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
