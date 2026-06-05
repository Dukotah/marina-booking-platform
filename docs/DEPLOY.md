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

## API (Hono) — not on Vercel

The API is a long-running Node server (`apps/api`). Target **Railway** or **Render**:
build `pnpm --filter @marina/api build`, start `node apps/api/dist/index.js`, set
`DATABASE_URL` / `DIRECT_URL` (Neon) + service keys. Tracked in ROADMAP "Blocked-on-owner".
