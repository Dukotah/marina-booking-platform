# Deployment

This is a **Turborepo monorepo with two Next.js apps** plus a Hono API. On Vercel,
each Next app is its own **Project** pointing at the same GitHub repo but a different
**Root Directory**. The API deploys separately (Railway/Render — see bottom).

## Vercel projects (one repo → two projects)

| Project | Root Directory | Framework | Domain (suggested) |
|---|---|---|---|
| `marina-web` | `apps/web` | Next.js | book.<domain> / customer portal |
| `marina-admin` | `apps/admin` | Next.js | admin.<domain> / operator app |

Vercel auto-detects Next.js + the pnpm workspace. Leave Build/Install commands on
their defaults — Vercel installs from the repo root (workspace-aware) and runs
`next build` in the root directory. `transpilePackages` in each app's
`next.config.mjs` compiles the shared `@marina/*` packages.

### Environment variables

**marina-web**
- `OPERATOR_SLUG` = `lake-sonoma` (dev default; later resolved from the request host)
- `API_URL` = the deployed API base URL (set once the API is live; until then the
  catalog page shows a graceful "not connected" state)

**marina-admin**
- `API_URL` = deployed API base URL (later)
- DB env (REQUIRED at runtime — admin queries the DB **directly**, decision D-007):
  `DATABASE_URL` (Neon pooled, owner), `DIRECT_URL` (Neon direct), `APP_DATABASE_URL`
  (`app_user` NOBYPASSRLS pooled — required for real tenant isolation), and
  `APP_DB_PASSWORD` if your `APP_DATABASE_URL` references it.
- Clerk keys (Phase 0.7): `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
- `API_URL` = deployed API base URL (later)

Both apps **build** with no env vars set. At **runtime**, `marina-web` degrades
gracefully (fetches via `API_URL`, shows a "not connected" state). `marina-admin`
queries the DB directly: it now degrades to an empty dashboard with a notice when the
DB is unreachable, but to show **real** data its Vercel project MUST have the DB env
vars above. (An earlier version of this doc wrongly claimed admin needed no env — the
missing DB vars are exactly what caused its first runtime 500.)

## Two ways to stand up the projects

### A) Dashboard Git import (recommended — gives auto-deploy on every push)
1. Go to https://vercel.com/new and import `Dukotah/marina-booking-platform`.
2. Create the **first** project → set **Root Directory** to `apps/web` → deploy.
3. Repeat **Add New → Project** on the same repo → Root Directory `apps/admin`.
Every `git push` to `main` then auto-deploys both. This is the "adjust online" flow.

### B) CLI (headless, token-based)
```bash
# one-time auth: either `vercel login` (interactive) or export a token
export VERCEL_TOKEN=...    # from https://vercel.com/account/tokens

# from repo root, link + deploy each app
cd apps/web   && vercel link --yes && vercel deploy --prod --token "$VERCEL_TOKEN"
cd apps/admin && vercel link --yes && vercel deploy --prod --token "$VERCEL_TOKEN"
# then connect the Git repo so pushes auto-deploy:
vercel git connect
```

---

# API (Hono) — not on Vercel

The API is a long-running Node server (`apps/api`). Target **Railway** or **Render**.

## How the API is built

`apps/api` is **bundled by esbuild into one self-contained ESM file**,
`apps/api/dist/index.js`. It is not compiled per-file by `tsc`.

**Why.** The shared `@marina/*` packages ship **TypeScript source** — their
`package.json` `main`/`types`/`exports` all point at `./src/index.ts`, and their
internal imports use NodeNext `.js` specifiers (`export … from './client.js'`). That
is decision **D-009**: the Next apps consume the source directly via
`transpilePackages` plus a webpack `resolve.extensionAlias` mapping `.js` →
`['.ts','.tsx','.js']`.

Nothing in that arrangement resolves at plain Node runtime. `tsc` copies module
specifiers through verbatim, so per-file `tsc` output for the API still contained
`import … from '@marina/database'`, Node resolved that to
`packages/database/src/index.ts`, and then died on its `./client.js` import because
only `client.ts` exists:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  …/packages/core/src/money.js imported from …/packages/core/src/index.ts
```

That was invisible in development because `pnpm dev` runs the API through `tsx`,
which applies the TypeScript `.js` → `.ts` resolution rule. `pnpm start` did not.

**esbuild applies the same `.js` → `.ts` rule at build time and inlines the workspace
packages into the output**, so the artifact has no `@marina/*` imports left to
resolve. This keeps the Next apps' consumption of TS source completely untouched (no
`exports` conditions to get wrong, no package-level `dist/` that can go stale), and
it adds no build step anyone has to remember: the shared packages are never built at
all — `pnpm --filter @marina/api build` is the whole story.

### What stays external

Only `@prisma/client` (and the generated `.prisma/client` it loads). Prisma ships
prebuilt JS plus a native query-engine binary that it locates relative to its own
package directory; bundling it would break that lookup. Everything else — `hono`,
`stripe`, `resend`, `@clerk/backend`, `zod`, `react` + `@react-email/components`
(pulled in by `@marina/emails`) — is inlined.

Two consequences:
- `@prisma/client` must be a **dependency of `apps/api`**, not just of
  `@marina/database`, because Node resolves it from `apps/api/dist/`.
- The deploy host must run **`prisma generate`** before `start`. `binaryTargets` in
  `packages/database/prisma/schema.prisma` already includes `rhel-openssl-3.0.x`.

### Build and run

```bash
pnpm install
pnpm --filter @marina/database generate     # generates @prisma/client
pnpm --filter @marina/api build             # -> apps/api/dist/index.js (+ .js.map)
node apps/api/dist/index.js                 # or: pnpm --filter @marina/api start
```

The build type-checks first (`tsc --noEmit`) and then bundles, so a deploy build
fails on a type error rather than shipping one. `apps/api/tsconfig.json` is
type-check-only (`noEmit`); the same is now true of every `packages/*/tsconfig.json`,
which makes it explicit that those packages have no build output by design.

esbuild transpiles file-by-file, so `isolatedModules` (set in `tsconfig.base.json`)
is load-bearing for the API — do not turn it off.

> If you are bundling for the first time in a working tree that still has the old
> per-file `tsc` output, delete `apps/api/dist` first. Stale `app.js`,
> `routes/*.js`, etc. are harmless but confusing next to a single bundled
> `index.js`.

Stack traces point into the bundle. `dist/index.js.map` is emitted next to it; run
with `node --enable-source-maps dist/index.js` to get original file/line numbers.

### Railway / Render settings

| Setting | Value |
|---|---|
| Install command | `pnpm install --frozen-lockfile` |
| Build command | `pnpm --filter @marina/database generate && pnpm --filter @marina/api build` |
| Pre-deploy / release | `pnpm --filter @marina/database migrate:deploy` |
| Start command | `node apps/api/dist/index.js` |
| Health check path | `/health` |

`PORT` is read from the environment (default 3001), which is what both platforms
inject.

### API environment variables

Required:
- `DATABASE_URL` — pooled owner connection (migrations, seed, platform ops)
- `DIRECT_URL` — direct connection (migrations)
- `APP_DATABASE_URL` — the `app_user` NOBYPASSRLS connection used by every
  tenant-scoped query. **Without it, RLS is not enforced** (D-010); the tenant client
  warns loudly and falls back to the owner connection.
- `APP_DB_PASSWORD` — only if `APP_DATABASE_URL` interpolates it

Sandbox / provider selection:
- `SANDBOX` — `local` runs the simulated providers (payments, email, SMS, storage,
  errors); unset/`cloud` uses the real ones. Production is `cloud`. See
  `docs/PROVIDER-MATRIX.md` and `docs/CUTOVER.md` for the full driver→twin table.
- `SANDBOX_UPLOAD_DIR`, `SANDBOX_WEBHOOK_URL` — local-driver overrides only

Cloud provider keys (each optional; the matching feature degrades to a clean
"not configured" response when absent):
- Payments: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- Email: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
- SMS: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
- Storage: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
  `R2_PUBLIC_BASE_URL`, `PUBLIC_UPLOAD_BASE_URL`
- Errors: `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`

Auth and URLs:
- `REQUIRE_CLERK_AUTH=true` + `CLERK_SECRET_KEY` — enforce real staff auth (D-012).
  Leave unset and the `x-dev-staff-id` shim stays active — **never do that in
  production.**
- `CUSTOMER_SESSION_SECRET`, `CUSTOMER_SESSION_COOKIE_DOMAIN` — customer portal
  sessions
- `ALLOWED_ORIGINS` — comma-separated CORS allowlist (web + admin origins)
- `APP_BASE_URL`, `API_BASE_URL`, `CUSTOMER_PORTAL_URL`, `APP_BASE_DOMAIN` — link
  generation and host→operator resolution
- `CRON_SECRET` — required bearer/`x-cron-secret` for `POST /internal/reminders/run`
  (D-015). Open when unset; **set it in production** and point a scheduler at that
  endpoint hourly.

Diagnostics: `APP_VERSION` / `GIT_COMMIT_SHA` are surfaced by `/health`.
