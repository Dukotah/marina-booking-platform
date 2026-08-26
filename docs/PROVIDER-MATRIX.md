# Provider Matrix — every local driver and its cloud twin

This is the Phase 6 table `docs/LOCAL-FIRST-BUILD.md` §10 asks for: every place the
product stands in for an external service, the exact environment variables that swap
it, what breaks if you flip one without the others, and a one-line smoke test that
proves the swap actually happened.

It was written by reading the code, not the docs. Where the code and the docs disagree,
the code wins and the disagreement is recorded in §5 — **Seams that do not exist yet**.
That section is the load-bearing part of this file. Do not go live against §2 alone.

Companion runbook: [`docs/CUTOVER.md`](CUTOVER.md).

---

## 1. How the switch works today

There is one intended rule, and it is written out three times in three processes:

```
SANDBOX=local  -> local drivers
SANDBOX=cloud  -> real providers
unset          -> local drivers unless NODE_ENV=production
```

| Copy | File | Symbol |
|---|---|---|
| API | `apps/api/src/services/sandbox.ts:28` | `sandboxEnabled()` |
| Admin | `apps/admin/app/dev/actions.ts:49` | `isSandboxEnabled()` |
| Web | `apps/web/app/checkout/wallet-config.ts:68` | `isSandboxRun()` |

The three bodies are currently identical, which is the only reason this works. They are
separate processes reading separate environments, so **`SANDBOX` must be set on all
three deployments or they will disagree** — a web checkout in `cloud` mode talking to an
API in `local` mode takes a real card number and settles it against a simulator.

`SANDBOX` appears in **neither** `.env` nor `.env.example` nor `.env.local.example`. Every
current local run is therefore relying on the `NODE_ENV !== 'production'` fallback rather
than an explicit flag. Setting `SANDBOX=local` explicitly in `.env` is a one-line change
that removes a whole class of surprise; it is listed as a required change in `CUTOVER.md`
Stage 0.

The default direction is deliberately safe: unset in production means *cloud*. A deploy
that forgets the flag fails loudly by not sending mail and by refusing an unconfigured
card, rather than quietly swallowing a paying customer's confirmation into a dev table.

---

## 2. The matrix

Legend for **Seam**: **OK** = a real interface with two drivers, selected by env.
**PARTIAL** = a seam exists but something still bypasses it. **NONE** = the behaviour is
baked in and cannot be swapped by configuration.

| # | Dependency | Local driver | Cloud twin | Env vars that switch it | Seam |
|---|---|---|---|---|---|
| 1 | Database | WSL Postgres 18 | Neon | `DATABASE_URL`, `DIRECT_URL`, `APP_DATABASE_URL`, `APP_DB_PASSWORD` | OK |
| 2 | Payments | `services/payments-sandbox.ts` | Stripe (`services/stripe.ts`) | `SANDBOX`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | **PARTIAL** — the wired local driver is the old `DEV_FAKE_PAYMENTS` toy, not the simulator |
| 3 | Card field (browser) | simulated card step | Stripe.js / Elements | `NEXT_PUBLIC_DEV_FAKE_PAYMENTS`, `NEXT_PUBLIC_DEMO_MODE`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | OK |
| 4 | Wallet buttons | simulated sheet | Stripe wallets | `SANDBOX`, `NEXT_PUBLIC_ENABLE_WALLET_PAY`, `NEXT_PUBLIC_WALLET_COUNTRY`, `NEXT_PUBLIC_WALLET_CURRENCY` | OK |
| 5 | Payment webhooks | `SandboxWebhook` + POST to own handler | Stripe webhooks | `SANDBOX`, `SANDBOX_WEBHOOK_URL`, `PORT`, `STRIPE_WEBHOOK_SECRET` | **PARTIAL** — the local loop 400s without a Stripe key |
| 6 | Email | `SandboxMessage` sink (`services/sandbox.ts`) | Resend (`services/notifications.ts`) | `SANDBOX`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | OK |
| 7 | SMS | same sink, `channel='SMS'` | Twilio (`services/sms.ts`) | `SANDBOX`, per-operator `Integration{key:'twilio'}`, else `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | OK |
| 8 | Staff auth (admin app) | dev OWNER fallback (`apps/admin/lib/session.ts`) | Clerk | `REQUIRE_CLERK_AUTH`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `PLATFORM_ADMIN_AUTH_IDS` | **PARTIAL** — falls back to OWNER even with Clerk enforced |
| 9 | Staff auth (API) | `x-dev-staff-id` header shim | Clerk bearer token | `REQUIRE_CLERK_AUTH`, `CLERK_SECRET_KEY` | OK |
| 10 | Customer auth | magic link into the sandbox inbox | magic link over Resend | `SANDBOX`, `CUSTOMER_SESSION_SECRET`, `CUSTOMER_PORTAL_URL` / `APP_BASE_URL` / `APP_BASE_DOMAIN` | **PARTIAL** — no token table, no registered cloud sender, route not mounted |
| 11 | Clock | `SandboxClock.offset_seconds` + `sandboxNow()` | system time | (no env; offset row = 0 means system time) | **PARTIAL** — only two call sites read it |
| 12 | Errors | `SandboxError` table + console | Sentry envelope over `fetch` | `SANDBOX`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_TIMEOUT_MS`, `ERROR_BURST_LIMIT`, `ERROR_SOURCE` | **PARTIAL** — nothing calls it |
| 13 | Channels / OTA | `MOCK` driver (`services/channel-mock.ts`) | a real partner driver | none — code registration via `registerChannelDriver()` | OK (no partner driver exists yet) |
| 14 | Accounting export | file download (CSV / IIF) | same file, imported by hand | none | OK — no account needed, ever |
| 15 | Customer catalog + orders | `DEMO_MODE` in-memory catalog + cookie orders | the real Hono API | `NEXT_PUBLIC_DEMO_MODE`, `API_URL`, `OPERATOR_SLUG` | **PARTIAL** — defaults ON |
| 16 | Object storage | — | Cloudflare R2 | — | **NONE** — provider not built; nothing uploads files yet |
| 17 | Rate limiting | in-process fixed window | Redis / Upstash | none | **NONE** — per-instance only |
| 18 | Scheduled jobs | manual POST | cron / Vercel Cron | `CRON_SECRET` | OK |
| 19 | CORS / origins | localhost auto-allowed | explicit allow-list | `ALLOWED_ORIGINS`, `APP_BASE_DOMAIN` | OK |

---

## 3. Per-dependency detail

Each entry gives the seam, the flip, the coupling (what breaks if you flip this and
nothing else), and a smoke test. Smoke tests assume the API on `:3001`, web on `:3000`
and admin on `:3002`; `curl` and `psql` are available from WSL.

### 1. Database — WSL Postgres → Neon

**Seam.** `packages/database/src/client.ts`. Two connections: `adminPrisma` on
`DATABASE_URL` (owner, BYPASSRLS) for migrations and genuine cross-tenant work, and
`appPrisma` on `APP_DATABASE_URL` (role `app_user`, NOBYPASSRLS) behind
`forOperator()` / `withTenant()` for everything else.

**Flip.** Repoint all four vars at Neon. `DIRECT_URL` must be the non-pooled string —
migrations fail through pgbouncer.

**Coupling.** If `APP_DATABASE_URL` is unset, tenant queries silently fall back to the
owner connection and **RLS is not enforced at all**. The code warns once on stdout
(`client.ts:43`) and keeps running. On Neon the `app_user` role does not exist until
`pnpm db:approle` has been run against that database. Flipping `DATABASE_URL` to Neon
without also creating the app role and setting `APP_DATABASE_URL` gives you a working
app with no tenant isolation, and nothing in the UI will tell you.

**Smoke test.** `pnpm --filter @marina/database test` — `tenant-isolation.test.ts`
fails closed if the connection can bypass RLS.
Secondary: `psql "$APP_DATABASE_URL" -c "select rolbypassrls from pg_roles where rolname=current_user"` must print `f`.

### 2. Payments — simulator → Stripe

**Seam (intended).** `services/payments-sandbox.ts` presents exactly the surface of
`services/stripe.ts`: `createPayment` / `refundPayment`, returning
`StripePaymentResult` / `StripeRefundResult`, throwing `StripePaymentError`. It
reproduces the PaymentIntent state machine — 3DS challenge, real decline codes, an
indeterminate network timeout, partial capture, partial refund, chargeback — and writes
Stripe-shaped webhook rows.

**Seam (actual).** Nothing imports it for charging. `apps/api/src/routes/payments.ts:26`
and `apps/api/src/services/booking.ts:28` both import `createPayment` from
`../services/stripe.js`. So the local driver that actually runs is the older
`isFakePaymentsEnabled()` branch at `stripe.ts:68`, which returns a hardcoded
`succeeded` with a Visa 4242 and can never decline, challenge, or time out. See §5.1.

**Flip.** Set `STRIPE_SECRET_KEY` (test key first) on the API, and
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` on the web app. Clear `DEV_FAKE_PAYMENTS` and
`NEXT_PUBLIC_DEV_FAKE_PAYMENTS`. Set `SANDBOX=cloud` on all three apps.

**Coupling.**
- `isFakePaymentsEnabled()` requires `DEV_FAKE_PAYMENTS=true` **and** `NODE_ENV !== 'production'` **and** no `STRIPE_SECRET_KEY`. Adding the key alone disables the fake path server-side. That is the safe direction.
- The browser is a **separate** switch. Setting `STRIPE_SECRET_KEY` without `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` leaves checkout on the simulated card step, which sends a fake `sourceId` to a real Stripe account: every charge fails with `resource_missing`.
- The reverse — publishable key set, secret key absent — makes checkout collect a real card and the API return 501.
- `NEXT_PUBLIC_*` values are inlined at **build** time. Changing them on Vercel requires a redeploy, not a restart.

**Smoke test.** `curl -s -X POST localhost:3001/api/payments/charge -H 'content-type: application/json' -H 'x-operator-slug: lake-sonoma' -d '{"orderId":"nope","sourceId":"pm_card_visa","amountCents":100}'` — cloud mode returns a Stripe `resource_missing` 402/502 (a real API round-trip happened); unconfigured returns `{"error":"payments not configured"}` 501; fake mode returns a `dev_pi_…` id.

### 3. Card field — simulated → Stripe.js

**Seam.** `apps/web/app/checkout/stripe-config.ts`. `fakeMode` is true only when there
is **no** publishable key **and** (`DEMO_MODE` or `NEXT_PUBLIC_DEV_FAKE_PAYMENTS=true`).

**Coupling.** `DEMO_MODE` defaults **on** (see #15), so a web deploy with no publishable
key and no `NEXT_PUBLIC_DEMO_MODE=0` renders a simulated card field to real customers.

**Smoke test.** Load `/checkout` and read the badge: a live Stripe Elements iframe with a
"Test" badge for `pk_test_`, versus the plain simulated input.

### 4. Wallet buttons

**Seam.** `apps/web/app/checkout/wallet-config.ts`. Three-state:
`NEXT_PUBLIC_ENABLE_WALLET_PAY` on/off/unset, unset follows the sandbox. `mode` is
`stripe` only when **not** sandboxed **and** a publishable key is present; in sandbox
mode the key is deliberately never sent to the browser.

**Coupling.** Flipping `SANDBOX=cloud` without a publishable key silently turns the
wallet off (`mode: 'sandbox'`, no key), rather than erroring. Real Apple Pay additionally
needs Stripe-side domain verification, which is not a code concern but will make the
button not render.

**Smoke test.** In the browser console on `/checkout`, a `stripe` mode page has loaded
`js.stripe.com`; a `sandbox` mode page has not.

### 5. Payment webhooks

**Seam.** `payments-sandbox.ts` writes a `SandboxWebhook` row per event and POSTs the
payload to `webhookEndpoint()` — `SANDBOX_WEBHOOK_URL`, defaulting to
`http://127.0.0.1:${PORT ?? 3001}/webhooks/stripe`. That is the point: the handler under
test is the production handler. Replay creates a **new** row referencing the original via
`replay_of_id`; originals are never mutated. `setSandboxWebhookDelivery()` swaps the
transport for in-process delivery in tests.

**Broken today.** `constructWebhookEvent` (`services/stripe.ts:259`) calls
`getStripeClient()` **before** the "no secret → parse unverified" branch, so with no
`STRIPE_SECRET_KEY` it throws `StripeNotConfiguredError`. That class extends `Error`, not
`StripePaymentError`, so `routes/webhooks.ts:98`'s catch falls through to
`400 Invalid webhook body`. In pure local mode the sandbox's own delivery therefore fails
and the row lands `FAILED`. See §5.2.

**Flip.** Set `STRIPE_WEBHOOK_SECRET` from the Stripe dashboard endpoint (or
`stripe listen`). Point the Stripe endpoint at `https://<api-host>/webhooks/stripe`.

**Coupling.** With the secret unset the handler accepts **unverified** JSON from anyone
who can reach the route — fine locally, an unauthenticated write path in production.
`/webhooks` is mounted outside the tenant middleware and resolves its tenant from the
payload, so a forged event can move a real payment's status.

**Smoke test.** `curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3001/webhooks/stripe -d '{}'` — `401` means signature verification is live; `400` means the Stripe key is missing; `200` means the route is accepting unverified events.

### 6. Email — sandbox sink → Resend

**Seam.** `services/notifications.ts:113` — the single `dispatch()` choke point branches
on `sandboxEnabled()` to `captureMessage()`, which writes a fully rendered
`SandboxMessage` (subject, HTML, text, from-address, order link). The Local Console inbox
reads it back. `deliverMagicLinkEmail` in `customer-auth.ts:681` has its own copy of the
same branch.

**Flip.** `SANDBOX=cloud` + `RESEND_API_KEY` + `RESEND_FROM_EMAIL` on a verified domain.

**Coupling.** `SANDBOX=cloud` with no `RESEND_API_KEY` does not throw — every send
returns `skipped('RESEND_API_KEY not configured')` and the booking succeeds silently
without a confirmation. The default `RESEND_FROM_EMAIL`
(`bookings@notifications.marina.app`) is a domain nobody here controls; leaving it unset
means Resend rejects every send. Unlike Twilio, the from-address is **global, not
per-operator** — every tenant's mail leaves from the same domain, with only the display
name white-labelled.

**Smoke test.** `psql "$DATABASE_URL" -c 'select channel, kind, created_at from "SandboxMessage" order by created_at desc limit 3'` — in cloud mode this table stops growing while orders keep arriving, and the message shows up in a real inbox instead.

### 7. SMS — sandbox sink → Twilio

**Seam.** `services/sms.ts:124`. `sendSms` normalizes to E.164 first, then branches on
`sandboxEnabled()` to the same sink with `channel: 'SMS'`.

**Flip.** `SANDBOX=cloud` plus either a per-operator `Integration` row
(`key='twilio'`, `enabled=true`, config `{account_sid, auth_token, from_number}`) or the
`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` env fallback. This is
the best-shaped provider in the codebase: the per-operator record wins, which is exactly
the "operators bring their own Twilio" model §0 is aiming for.

**Coupling.** No SDK — a raw `fetch` to Twilio's REST API, so nothing to install. A
missing config is a `skipped`, never an error. US/CA (+1) is assumed for 10-digit input
(`toE164`, `sms.ts:90`); an international customer's number returns `null` and the text
is skipped with no visible failure.

**Smoke test.** `pnpm --filter @marina/api test -- sms` (pure unit, no network), then in
cloud mode confirm a real text arrives — `SandboxMessage` must show **no** new `SMS` row
for that order.

### 8. Staff auth, admin app — dev OWNER → Clerk

**Seam.** `apps/admin/lib/session.ts`. `clerkConfigured()` requires
`REQUIRE_CLERK_AUTH='true'` **and** both keys. `apps/admin/middleware.ts` runs
`clerkMiddleware` whenever a publishable key exists but only calls `auth.protect()` when
enforcement is on.

**Flip.** `REQUIRE_CLERK_AUTH=true` + both Clerk keys + `PLATFORM_ADMIN_AUTH_IDS` (the
comma-separated Clerk user ids allowed into the platform/super-admin cockpit) + a
`StaffMember` row whose `auth_user_id` is the Clerk user id.

**Coupling.** Two real problems, both in §5.3: `resolveBaseContext` returns the dev OWNER
context when there is no session (`session.ts:108`) or no matching staff row
(`session.ts:116`) **even with Clerk enforced**; and `resolveStaff` looks up staff through
`forOperator('lsra')` (`session.ts:153`), so a second operator's staff can never sign in.
Also: `isPlatformAdmin` treats the literal id `dev-owner` as a platform admin whenever
`REQUIRE_CLERK_AUTH !== 'true'` (`lib/platform.ts:24`) — that switch, not `SANDBOX`, is
what guards the super-admin cockpit.

**Smoke test.** With enforcement on, in a private window: `GET /` on the admin app must
redirect to `/sign-in`, and after signing in the header must show the real staff name —
**not** "dev-owner". Confirming the redirect alone is not enough; the fallback is
downstream of the middleware.

### 9. Staff auth, API — header shim → Clerk bearer

**Seam.** `apps/api/src/middleware/auth.ts`. Enforced: verifies a Clerk session token
from `Authorization: Bearer`. Not enforced: trusts `x-dev-staff-id`. Either way it then
loads the active `StaffMember` **through the tenant client**, so RBAC and RLS agree.

This one is production-safe as written: no token means `401`, no shim fallback.

**Coupling.** `CLERK_SECRET` and `ENFORCE_CLERK` are read at module load, so changing
them needs an API restart. `x-dev-staff-id` is in the CORS `allowHeaders` list
(`app.ts:75`) in every mode; harmless once enforcement is on, but worth removing.

**Smoke test.** `curl -s -o /dev/null -w '%{http_code}' localhost:3001/api/orders -H 'x-operator-slug: lake-sonoma' -H 'x-dev-staff-id: anything'` — `401` means Clerk is enforced; `200`/`403` means the dev shim is still live.

### 10. Customer auth — magic link

**Seam.** `services/customer-auth.ts`. Split `selector.verifier` token, SHA-256 of the
verifier stored, single-use enforced by `updateMany({where:{consumed_at:null}})`,
`timingSafeEqual` compare, no user-enumeration in the response. Local delivery captures
the rendered email to the sandbox inbox; cloud delivery goes through a sender registered
with `setMagicLinkEmailSender()`.

**Not usable in cloud mode today.** Three independent blockers, all in §5.4: the
`CustomerAuthToken` model is not in `schema.prisma`, so the store falls back to
in-process memory and **throws outright in production** (`customer-auth.ts:342`);
`setMagicLinkEmailSender()` is never called anywhere, so cloud mode logs "the sign-in link
was NOT delivered"; and `apps/api/src/routes/customer-auth.ts` is not mounted in
`app.ts`.

**Flip (once unblocked).** `CUSTOMER_SESSION_SECRET` (required in production — the code
throws without it) and `CUSTOMER_PORTAL_URL` pointing at the public web host.

**Smoke test.** Request a link, then `psql "$DATABASE_URL" -c 'select count(*) from "CustomerAuthToken"'` must return ≥ 1. If the relation does not exist, the memory store is in use and every link dies at the next restart.

### 11. Clock

**Seam.** One `SandboxClock` row per operator holding `offset_seconds`.
`sandboxNow(db, operatorId)` returns `Date.now() + offset*1000`. The Local Console's
Clock tab moves the offset cumulatively.

**Only two call sites read it**: `services/channels.ts:33` and
`services/customer-auth.ts:54`. The reminder sweep uses
`opts.now ?? new Date()` (`notifications.ts:577`) and `/internal/reminders/run` passes no
`now`, so **jumping the clock does not make a reminder fire** — contradicting both §4.2 of
the build contract and the ClockControl component's own on-screen text. See §5.5.

**Flip.** There is no env var. Cloud behaviour is "offset is 0", which is what a fresh
database gives you. `SandboxClock` is a tenant table under RLS like any other, so it
would ship to production with a zero row and be inert — acceptable, but it should be
cleared during cutover so nobody discovers a `+72h` offset on a live tenant.

**Smoke test.** `psql "$DATABASE_URL" -c 'select operator_id, offset_seconds from "SandboxClock"'` must be empty or all zeroes before go-live.

### 12. Errors — SandboxError → Sentry

**Seam.** `services/errors.ts` is the best-built provider in the repo and the only one
with a named interface (`ErrorSink`) and two named implementations
(`localErrorSink`, `cloudErrorSink`), selected by `errorSink()` at line 617. The cloud
driver posts a Sentry **envelope** over plain `fetch` — no SDK, no new dependency. Both
drivers scrub secrets (`scrubText`) and card numbers before storage, and `captureError`
never throws.

**Nothing calls it.** `app.onError` (`apps/api/src/app.ts:119`) is still
`console.error(err)`. `captureError` and `captureHonoError` have zero call sites outside
their own module, so the `SandboxError` table is always empty and the Local Console's
Errors tab always reads "nothing". See §5.6.

**Flip (once wired).** `SANDBOX=cloud` + `SENTRY_DSN`. Optional: `SENTRY_ENVIRONMENT`,
`SENTRY_RELEASE` (falls back to `APP_VERSION`), `SENTRY_TIMEOUT_MS`, `ERROR_BURST_LIMIT`,
`ERROR_SOURCE`.

**Coupling.** The local driver writes to a tenant table under RLS, so an error with no
operator (startup failure, cross-tenant sweep) can only ever reach stderr. That is a
deliberate choice, documented in the file — but it means local error capture has a blind
spot exactly where production has one too.

**Smoke test (after wiring).** Hit a deliberately broken route; locally
`select count(*) from "SandboxError"` increments, in cloud mode the event appears in
Sentry and that table does not move.

### 13. Channels / OTA

**Seam.** `services/channels.ts:269` — a `Map<ChannelKind, ChannelDriverFactory>` with
`MOCK` registered. `registerChannelDriver(kind, factory)` slots a real partner in without
touching the file; `driverFor` throws a clean `501 DRIVER_NOT_IMPLEMENTED` otherwise.

The `MOCK` driver (`channel-mock.ts`) is a genuine simulation: it sells from a stale
inventory snapshot (so oversell is normal, not an edge case), delivers at-least-once,
manufactures arrivals against the sandbox clock, produces guest cancellations, and can be
told to fail a push or a pull. Its whole state lives in `Channel.config.driver` with a
seeded xorshift PRNG, so a run is reproducible from its seed.

**Flip.** No env var. A partner driver is code plus per-channel credentials in
`Channel.config`, and commission is snapshotted in cents at import so a later rate change
never rewrites past commissions.

**Coupling.** `apps/api/src/routes/channels.ts` exists but is **not mounted** in
`app.ts`, so none of this is reachable over HTTP yet.

**Smoke test.** `psql "$DATABASE_URL" -c $'select kind, count(*) from "Channel" group by 1'` — any row that is not `MOCK` needs a registered driver, or every sync returns 501.

### 14. Accounting export

No external dependency at all, in either mode: `services/accounting.ts` builds a period's
rows from `GLAccount.category` and serializes to QuickBooks CSV, QuickBooks IIF, or Xero
CSV for manual import. The operator needs a QuickBooks or Xero login to *import* the file;
this product needs no account, no API key, and no OAuth. Nothing to swap. This is the
correct shape — resist any future pull toward a live QuickBooks API integration before
the file path has been reconciled against a real day.

**Smoke test.** Generate an export for a past day and check the total against the same
day's paid-orders sum.

### 15. Customer catalog and orders — DEMO_MODE

**Seam.** `apps/web/lib/demo/config.ts:12`:

```ts
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === '0' ? false : true;
```

**Default ON.** When on, `apps/web/lib/api.ts` serves an in-memory catalog and a
cookie-backed order store instead of calling the API — no database, no API, no Stripe.
`.env` here sets `NEXT_PUBLIC_DEMO_MODE="0"`, but neither `.env.example` nor
`.env.local.example` mentions the variable at all.

**Coupling.** A web deploy that does not set `NEXT_PUBLIC_DEMO_MODE=0` shows real
customers a fake catalog and takes fake bookings that exist only in their own cookie.
Because it is a `NEXT_PUBLIC_` value it is baked at build time, so fixing it needs a
rebuild, not a restart. This is the single most dangerous default in the repo for a
cutover, and it is not covered by `SANDBOX` at all. See §5.7.

**Smoke test.** `curl -s localhost:3000/ | grep -c 'Simulated payments'` — the demo
banner (`components/layout/SiteHeader.tsx:69`) renders only in demo mode. Zero matches
means the real API path is live.

### 16. Object storage

Does not exist. There is no `storage.ts`, no upload route, no R2/S3 reference anywhere in
`apps` or `packages`. Nothing currently needs it: waiver signatures are stored as
`signature_data` on the `WaiverSignature` row, activity photos are URLs, and operator
logos are URLs. The `.sandbox/uploads` driver in build-contract §4.1 is unbuilt because
nothing yet has a file to put in it. That is the right order — but §4.1's table should
not be read as describing something that exists.

### 17. Rate limiting

`apps/api/src/middleware/rate-limit.ts` is a fixed-window counter in process memory, keyed
by IP + tenant + route. It has no cloud twin and no env var. Its own header comment is
honest about this: limits are per-instance, and a horizontal scale-out or a serverless
deploy needs a Redis/Upstash store behind the same factory. On a single API instance this
is correct behaviour, not a stub — but "we are rate limited" stops being true the moment
there are two instances, and nothing will tell you.

### 18. Scheduled jobs

`POST /internal/reminders/run`, gated by `CRON_SECRET` as
`Authorization: Bearer` or `x-cron-secret`. **When `CRON_SECRET` is unset the endpoint is
open** (`routes/internal.ts:25`) — deliberate for local dev, unacceptable in production.

**Smoke test.** `curl -s -o /dev/null -w '%{http_code}' -X POST https://<api-host>/internal/reminders/run` with no auth header must return `401`.

### 19. CORS and origins

`ALLOWED_ORIGINS` (comma-separated) is the source of truth; unset falls back to origins
derived from `APP_BASE_DOMAIN`, and any localhost origin is additionally allowed whenever
`NODE_ENV !== 'production'`.

**Smoke test.** `curl -s -i https://<api-host>/api/whoami -H 'Origin: https://evil.example' -H 'x-operator-slug: lake-sonoma' | grep -i access-control-allow-origin` must print nothing.

---

## 4. Environment variables, by app

`SANDBOX`, `NODE_ENV` and the database vars must agree across all three deployments.

| Variable | api | web | admin | Notes |
|---|:--:|:--:|:--:|---|
| `SANDBOX` | ● | ● | ● | `local` \| `cloud`. Not in any `.env` template yet. |
| `DATABASE_URL` | ● | | ● | owner connection; admin queries the DB directly (D-007) |
| `DIRECT_URL` | ● | | ● | migrations only; must not be pooled |
| `APP_DATABASE_URL` | ● | | ● | non-bypass role — **RLS is off without it** |
| `APP_DB_PASSWORD` | ● | | ● | only if referenced by the URL |
| `STRIPE_SECRET_KEY` | ● | | | |
| `STRIPE_WEBHOOK_SECRET` | ● | | | unset = unverified webhooks accepted |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | | ● | | build-time inline |
| `DEV_FAKE_PAYMENTS` | ● | | | must be cleared at cutover |
| `NEXT_PUBLIC_DEV_FAKE_PAYMENTS` | | ● | | must be cleared at cutover |
| `NEXT_PUBLIC_DEMO_MODE` | | ● | | **must be `0`** — default is demo ON |
| `NEXT_PUBLIC_ENABLE_WALLET_PAY` | | ● | | on/off/unset(follow sandbox) |
| `NEXT_PUBLIC_WALLET_COUNTRY` / `_CURRENCY` | | ● | | default `US` / `usd` |
| `RESEND_API_KEY` | ● | | | |
| `RESEND_FROM_EMAIL` | ● | | | must be a verified domain |
| `TWILIO_ACCOUNT_SID` / `_AUTH_TOKEN` / `_FROM_NUMBER` | ● | | | fallback under the per-operator `Integration` |
| `REQUIRE_CLERK_AUTH` | ● | | ● | the auth master switch, not `SANDBOX` |
| `CLERK_SECRET_KEY` | ● | | ● | read at module load in the API |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | | | ● | |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` etc. | | | ● | |
| `PLATFORM_ADMIN_AUTH_IDS` | | | ● | super-admin allow-list |
| `CUSTOMER_SESSION_SECRET` | ● | | | required in production; API throws without it |
| `CUSTOMER_PORTAL_URL` / `APP_BASE_URL` | ● | | | magic-link base |
| `SENTRY_DSN` (+ `_ENVIRONMENT`, `_RELEASE`, `_TIMEOUT_MS`) | ● | | | |
| `ERROR_BURST_LIMIT`, `ERROR_SOURCE` | ● | | | |
| `SANDBOX_WEBHOOK_URL` | ● | | | sandbox delivery target |
| `CRON_SECRET` | ● | | | **unset = the sweep endpoint is open** |
| `ALLOWED_ORIGINS` | ● | | | |
| `APP_BASE_DOMAIN` | ● | ● | ● | |
| `API_URL` | | ● | ● | |
| `OPERATOR_SLUG` | | ● | | |
| `PORT` | ● | | | |
| `HEALTH_TIMEOUT_MS` | ● | | | readiness probe timeout |

---

## 5. Seams that do not exist yet

The honest list. Each of these is a place where sandbox behaviour is **baked in** rather
than behind the seam, or where the seam exists but is bypassed. Each one is a thing that
would go wrong at cutover in a way the matrix above would not catch. They are ordered by
how much damage they do at go-live.

### 5.1 The payment simulator is not wired in — the toy is

`services/payments-sandbox.ts` is 1,555 lines of faithful Stripe simulation and **nothing
charges through it**. Both charge call sites import `createPayment` from
`../services/stripe.js`:

- `apps/api/src/routes/payments.ts:26`
- `apps/api/src/services/booking.ts:28`

so the live local driver is `stripe.ts:149`, which returns a hardcoded success. Consequences:

- The Local Console's "force the next outcome" queue writes `QUEUED`
  `SandboxPaymentAttempt` rows that are never popped, because nothing calls
  `chargeWithStore`. The Payments tab will show instructions that never fire.
- 3DS, declines, timeouts, partial capture and chargebacks are **unreachable** locally, so
  Phase 1's acceptance criterion ("an E2E spec drives every outcome the simulator can
  produce") cannot be met.
- The `Order.idempotency_key` / `Payment.idempotency_key` guard the schema owner added
  cannot be exercised, because the fake path can never produce the indeterminate timeout
  that idempotency exists to recover from.

**The fix is a driver selector, not a rewrite.** One module that exports `createPayment` /
`refundPayment` and picks `payments-sandbox` vs `stripe` on `sandboxEnabled()`, with both
call sites importing it instead. `payments-sandbox.ts` was written to be a drop-in: same
signatures, same result types, same error class. Until that exists, row 2 of the matrix
describes an intention, not the build.

### 5.2 The local webhook loop cannot complete without a Stripe key

`constructWebhookEvent` (`services/stripe.ts:259`) calls `getStripeClient()` before
checking whether a webhook secret is configured, so with no `STRIPE_SECRET_KEY` it throws
`StripeNotConfiguredError` — which is not a `StripePaymentError`, so
`routes/webhooks.ts:98` returns `400 Invalid webhook body` rather than the intended
"parse unverified in dev" behaviour.

The sandbox POSTs its simulated events at that same route, so in the exact configuration
the build contract mandates — no accounts anywhere — every delivery fails and every
`SandboxWebhook` row lands `FAILED`. The console's Replay button will faithfully replay
the failure.

Two ways out, both small: move the `getStripeClient()` call below the `if (!secret)`
branch, or have the sandbox deliver in-process via `setSandboxWebhookDelivery()` instead
of over loopback. The first is better — it keeps the production handler in the path.

### 5.3 The admin dev-auth fallback is not gated, and is hardcoded to one tenant

`apps/admin/lib/session.ts:93-117`. `resolveBaseContext()` returns
`devFallbackContext()` — a full **OWNER** context on operator `lsra` — in four cases:

| Line | Case |
|---|---|
| 95 | Clerk not configured |
| 104 | `auth()` threw |
| 108 | Clerk configured, **no session** |
| 116 | Clerk configured, session valid, **no matching staff row** |

Cases 108 and 116 fire with `REQUIRE_CLERK_AUTH=true`. `middleware.ts` calls
`auth.protect()` on non-public routes, so a browser is redirected to `/sign-in` before it
gets there — but the middleware matcher excludes anything with a dot in the path
(`'/((?!_next|.*\\..*).*)'`), and a **server action is its own endpoint**. Any request
path that reaches a server component or action without passing the matcher resolves to
OWNER on `lsra`.

Separately, `resolveStaff` (`session.ts:153`) resolves every Clerk identity through
`forOperator('lsra')` — the seed operator, hardcoded. A second operator's staff member
signs in successfully with Clerk, finds no staff row under `lsra`, and lands in case 116:
they get **OWNER access to Lake Sonoma's data**. That is a cross-tenant leak, and it is
the one item on this list that is a security bug rather than a cutover inconvenience.

Correct shape: the fallback must be gated on `sandboxEnabled()` (or at minimum on
`!clerkConfigured()`), cases 108 and 116 must deny rather than fall back, and staff
resolution needs to run through `adminPrisma` with an explicit cross-tenant lookup — the
same deliberate exception `routes/webhooks.ts` already makes — or resolve the operator
from the request host first.

### 5.4 Customer magic-link auth cannot be turned on at all

Three independent blockers:

1. **No token table.** `CustomerAuthToken` is not in `packages/database/prisma/schema.prisma`.
   `createMagicLinkStore` (`customer-auth.ts:338`) detects the missing delegate, warns,
   and uses a per-operator in-memory `Map` — and **throws in production**
   (`customer-auth.ts:342`), by design. So `SANDBOX=cloud` + `NODE_ENV=production` means
   the customer portal's sign-in path throws on first use.
2. **No registered cloud sender.** `setMagicLinkEmailSender()` (`customer-auth.ts:674`)
   has no call site anywhere in the repo. In cloud mode `deliverMagicLinkEmail` logs
   `SANDBOX=cloud but no email sender is registered — the sign-in link was NOT delivered`
   and returns `skipped`. The customer sees the same "check your email" response either
   way, because the endpoint deliberately does not reveal whether the address exists.
3. **Route not mounted.** `apps/api/src/routes/customer-auth.ts` exists and is complete
   but does not appear in `apps/api/src/app.ts`.

The service itself is well built — split token, hashed verifier, DB-enforced single use,
`timingSafeEqual`, no enumeration. It is the wiring that is missing.

### 5.5 The clock seam exists but almost nothing reads it

`sandboxNow()` has exactly two consumers: `channels.ts` and `customer-auth.ts`. The
reminder sweep does not use it (`notifications.ts:577` takes `opts.now ?? new Date()`,
and `routes/internal.ts` passes no `now`), and neither does `booking.ts`,
`availability.ts`, or `waivers-service.ts`.

So the Local Console's Clock tab moves a number that most of the product ignores. Its own
help text says *"Everything time-dependent — reminders, no-show sweeps, cancellation
windows, membership expiry — reads the clock through this offset"*
(`components/dev/ClockControl.tsx:147`). That is not true today, and it is the kind of
false statement that costs more than a missing feature: an owner who jumps the clock,
sees no reminder, and concludes the reminder engine is broken.

The console also has no "run any sweep on demand" control, which build-contract §4.2
requires alongside the clock — so there is currently no way to make a reminder fire from
the UI at all.

Fix: thread an optional `now` through the time-dependent services and have the
console's sweep action pass `sandboxNow()`. Until then, either wire it or correct the
component's text.

### 5.6 The error provider has no callers

`services/errors.ts` is complete, two-driver, secret-scrubbing, burst-limited, and
never invoked. `apps/api/src/app.ts:119` is still `console.error(err)`. `SandboxError`
therefore stays empty and the Local Console's Errors tab (`app/dev/page.tsx:89`) always
renders its empty state.

The wiring is one line in `app.onError` plus a `void captureError(...)` in the places
that currently swallow (`notifications.ts`, `sms.ts`, `sandbox.ts`, `audit.ts` all
`console.error` and continue). Note that this is also what makes the Sentry swap real:
today, setting `SENTRY_DSN` in production changes nothing.

### 5.7 `DEMO_MODE` defaults on and is outside the sandbox switch

Covered in §3.15. Repeated here because it is the one that reaches customers: a web
deploy without `NEXT_PUBLIC_DEMO_MODE=0` sells from a fake catalog into a cookie. It is
not governed by `SANDBOX`, it is not in `.env.example`, and being `NEXT_PUBLIC_` it is
frozen at build time.

The right fix is to invert the default (`=== '1'` rather than `!== '0'`) and, better, to
fold it into `isSandboxRun()` so there is one switch instead of two.

### 5.8 Four completed routes are not mounted

`apps/api/src/app.ts` mounts 17 routers. These exist and are not among them:

| Route file | What is unreachable |
|---|---|
| `routes/health.ts` | `/health/live`, `/health/ready`, `/health/info` — including the readiness check that reports `degraded` when a production deploy is still on the sandbox drivers. `app.ts:81` has a stub `GET /health` returning `{ok:true}` that shadows it. |
| `routes/customer-auth.ts` | magic-link request + redeem |
| `routes/channels.ts` | all OTA distribution |
| `routes/accounting.ts` | QuickBooks / Xero export |

The health one matters most for cutover: `routes/health.ts` already implements the exact
"are we accidentally still in sandbox mode in production" probe this document would
otherwise have to invent, and it is not on the network.

### 5.9 The no-direct-import lint rule does not exist

Build-contract §4.1 ends: *"no application code may import Stripe/Resend/Twilio directly.
A lint rule should enforce this."* There is **no ESLint config anywhere in the repo** —
no `.eslintrc*`, no `eslint.config.*`. `apps/web` and `apps/admin` have a `lint` script
(`next lint`); `apps/api`, `packages/core` and `packages/database` have none. And
`pnpm verify` is `typecheck test build` — lint is not in it.

So the rule that is supposed to keep this matrix writable is not enforced by anything,
and `routes/payments.ts` importing `stripe.js` directly (§5.1) is exactly the violation
it was meant to catch.

### 5.10 The sandbox rule is copy-pasted across three processes

§1. Three identical function bodies in three packages. Nothing keeps them in step, and
there is no test asserting they agree. A fourth copy will eventually drift. This belongs
in `@marina/core` or a small `@marina/providers` package, exported once.

### 5.11 Rate limiting has no cloud twin

§3.17. In-process only. Not a blocker for a single-instance API, but the moment the API is
deployed with more than one instance, or serverless, the limits silently stop meaning what
the tests say they mean. There is no env var and no interface — the store is a module-level
`Map`. The factory signature is fine; only the store needs replacing.

---

## 6. What is genuinely well seamed

Worth stating, because the list above is long and the architecture is mostly right:

- **Email and SMS** are exemplary. One choke point each, one branch on one rule, both
  never throw, and Twilio config resolves per-operator from an `Integration` row before
  falling back to env — which is precisely the "operators bring their own" model that
  makes the constraint pay for itself.
- **The error provider** is the cleanest interface in the repo: a named `ErrorSink` type
  with two implementations and a selector. It just needs callers.
- **The channel registry** is the right abstraction — a map of factories with a clean 501
  for unimplemented partners, and a mock that oversells, retries and fails on demand
  rather than pretending.
- **The API's staff auth** fails closed. So does `withTenant` / `forOperator`.
- **The accounting export** needs no account in either mode, which is the ideal end state
  for any provider that can be a file instead of an API.
