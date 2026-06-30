# Run it locally — zero external accounts

Dogfood the whole product on your machine with **no Stripe, Clerk, Resend, Neon, or
Vercel**. Everything that needs a paid/external service has a dev fallback, and the
database is a local Postgres. Wire the real services later (see
[`HANDOFF.md`](HANDOFF.md)); nothing here touches them.

## What's stubbed in dev

| Service | Real | Local dev fallback |
|---|---|---|
| Database | Neon Postgres | Local Postgres (role+db `marina`) |
| Auth | Clerk | `REQUIRE_CLERK_AUTH=false` → admin OWNER fallback + API `x-dev-staff-id` shim |
| Payments | Stripe | `DEV_FAKE_PAYMENTS=true` → charges/refunds simulated (Visa •4242). **Never active in production.** |
| Email | Resend | No key → notifications log to console and no-op (never block a booking) |

## Prerequisites

- Node 20+ and `pnpm` (`npm i -g pnpm`)
- A local PostgreSQL. On Debian/Ubuntu/WSL: `sudo apt install postgresql`

## Setup (once)

```bash
bash scripts/setup-local.sh
```

This starts Postgres, creates the `marina` role + database, copies
`.env.local.example` → `.env`, installs deps, applies migrations + RLS, and seeds
**Lake Sonoma Marina** (19 activities + 30 days of bookable timeslots).

## Run

```bash
bash scripts/dev-local.sh
```

- Customer site → http://localhost:3000
- Admin dashboard → http://localhost:3002
- API → http://localhost:3001

## Try the full flow

1. Open the customer site, pick an activity, choose a date + time, go to checkout.
2. Fill in your details. The payment box shows **"Dev mode — payment simulated"** —
   just click **Complete booking** (no card needed).
3. You land on the confirmation page (paid in full).
4. **Manage it:** the customer site → *My Booking* (`/account`), look it up with the
   order number + the email you used, then **Reschedule** it to a new slot.
5. **Operator view:** open the admin dashboard — the booking shows in revenue, Orders,
   the calendar, and the day manifest.

## Reset the data

Re-running the seed wipes and recreates the tenant (orders included), so you get a
clean slate:

```bash
set -a; . ./.env; set +a
pnpm db:seed
```

## Gotchas

- **WSL + `/mnt/c`:** the Windows filesystem doesn't emit file-change events, so the
  API's `tsx watch` won't hot-reload. After editing API code, Ctrl-C and re-run
  `scripts/dev-local.sh`. Next.js (web/admin) hot-reloads fine. (Cloning to the WSL
  filesystem, e.g. `~/`, restores API hot-reload.)
- **`APP_DATABASE_URL not set` warning:** expected locally. Tenant queries fall back
  to the owner connection, so cross-tenant RLS isolation isn't enforced — fine for
  single-tenant dogfooding. Production sets the non-bypass app role (see HANDOFF).
- **Port already in use:** an old dev server is still running. Find and stop it:
  `lsof -ti:3001 | xargs -r kill` (repeat for 3000/3002).
- **Env isn't auto-loaded:** the API and Prisma scripts read `process.env` with no
  dotenv autoload. The `scripts/*.sh` wrappers source `.env` for you; if you run a
  command by hand, do `set -a; . ./.env; set +a` first.
