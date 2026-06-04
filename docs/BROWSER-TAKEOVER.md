# Browser-takeover prompt

The Claude Code agent (running locally on the owner's machine) has built the platform
but **cannot create third-party accounts or click through provider dashboards**. Those
tasks need a browser. Copy everything in the box below into **Claude for Chrome / a
Claude session with web browsing** and let it drive. When it finishes, paste the
collected secrets back to the local agent, which will write them into `.env` and run
the live database + smoke-test sequence.

> **Security note:** these are real credentials. Prefer **sandbox/test** keys
> everywhere. Paste secrets back over a trusted channel only. Never commit `.env`.

---

```
You are taking over browser-only setup tasks for a software project called the
"Marina Booking Platform" — a multi-tenant SaaS booking system. A separate coding
agent has already built and pushed all the code to GitHub (Dukotah/marina-booking-platform)
and it is deploy-ready, but it has no live accounts/keys yet. Your job is to create the
external accounts, provision the services, and collect the connection strings + API keys
so the coding agent can drop them into a .env file and go live.

Work through the tasks below in order. For each one: do it in the browser, then report
back the exact value(s) requested under a clear heading. If a step needs a human decision
(billing, a password, a phone verification), pause and ask the owner (Dukotah,
dukotah@gmail.com) rather than guessing. Prefer free tiers and SANDBOX/TEST modes.

=== TASK 1 — Neon Postgres (HIGHEST PRIORITY; everything else is blocked on this) ===
1. Go to https://neon.tech and sign in / create an account (owner can use Google /
   dukotah@gmail.com).
2. Create a new Project named "marina-booking" (region: US West if offered, closest to
   California / Lake Sonoma).
3. Open the project's Connection Details. Collect BOTH of these:
   - POOLED connection string (the one labeled "Pooled connection", includes
     `-pooler` in the host and `pgbouncer=true`). This becomes DATABASE_URL.
   - DIRECT connection string (no pgbouncer). This becomes DIRECT_URL.
   Make sure each ends with `?sslmode=require` (Neon usually includes it).
REPORT:
   DATABASE_URL = postgresql://...-pooler.../...?sslmode=require&pgbouncer=true
   DIRECT_URL   = postgresql://.../...?sslmode=require

=== TASK 2 — Vercel (deploy the two front-end apps; gives auto-deploy on every push) ===
This repo is a monorepo with TWO Next.js apps that each become their own Vercel project,
pointing at the same GitHub repo but different Root Directories.
1. Go to https://vercel.com/new and import the GitHub repo Dukotah/marina-booking-platform
   (connect GitHub if prompted).
2. Create project #1: name "marina-web", set **Root Directory = apps/web**. Leave
   build/install commands on defaults (Vercel is pnpm-workspace aware). Deploy.
3. Add New → Project on the SAME repo: name "marina-admin", set
   **Root Directory = apps/admin**. Deploy.
4. Both apps build fine with NO env vars (they show graceful "not connected" states), so
   deploying before the API exists is expected and fine.
REPORT:
   - marina-web production URL
   - marina-admin production URL
   - confirm "auto-deploy on push to main" is enabled for both

=== TASK 3 — Clerk (auth: operators/staff + magic-link customers) ===
1. Go to https://clerk.com, create an application named "Marina Booking".
2. From API Keys, collect the DEVELOPMENT keys:
   - Publishable key (starts with pk_test_...)
   - Secret key (starts with sk_test_...)
REPORT:
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = pk_test_...
   CLERK_SECRET_KEY = sk_test_...

=== TASK 4 — Square (payments, SANDBOX first) ===
1. Go to https://developer.squareup.com/apps, sign in, create an application
   "Marina Booking".
2. Switch to the **Sandbox** tab and collect:
   - Sandbox Access Token
   - Application ID (sandbox)
   - A Sandbox Location ID (from the sandbox test account's Locations)
REPORT:
   SQUARE_ENVIRONMENT = sandbox
   SQUARE_ACCESS_TOKEN = ...
   SQUARE_APPLICATION_ID = ...
   SQUARE_LOCATION_ID = ...

=== TASK 5 — Resend (transactional email) ===
1. Go to https://resend.com, create an account, create an API key named "marina".
   (Domain verification can wait; the key alone lets us send from the Resend test domain.)
REPORT:
   RESEND_API_KEY = re_...

=== WHEN DONE ===
Compile all REPORT values into a single block in this exact .env format and hand it to
the owner / the coding agent:

  DATABASE_URL="..."
  DIRECT_URL="..."
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="..."
  CLERK_SECRET_KEY="..."
  SQUARE_ENVIRONMENT="sandbox"
  SQUARE_ACCESS_TOKEN="..."
  SQUARE_APPLICATION_ID="..."
  SQUARE_LOCATION_ID="..."
  RESEND_API_KEY="..."
  APP_BASE_DOMAIN="localhost:3000"

Also report the two Vercel URLs separately (they go into each Vercel project's env as
API_URL once the API is deployed, not into .env).

If you can only finish TASK 1 (Neon), that alone unblocks the most important next step —
report it immediately rather than waiting to finish everything.
```

---

## What the local agent does once these come back

1. Write the values into `C:\Users\Jeff\marina-booking-platform\.env` (gitignored).
2. `pnpm db:migrate` → `pnpm db:rls` → `pnpm db:seed`.
3. `pnpm --filter @marina/database test` → cross-tenant isolation suite now runs live.
4. `pnpm --filter @marina/api dev` + the apps → smoke-test catalog → booking → payment
   (Square sandbox) → confirmation email (Resend).
5. In each Vercel project, set `API_URL` (and Clerk keys on `marina-admin`) once the API
   is deployed to Railway/Render.
