# Cutover — taking Lake Sonoma Marina live

This is the ordered runbook for going from "runs on the owner's laptop with no accounts"
to "takes a real customer's money for a real boat rental." Read
[`docs/PROVIDER-MATRIX.md`](PROVIDER-MATRIX.md) first — it is the reference for every
variable named here, and its §5 lists the things that are **not** yet swappable by
configuration.

Two rules govern this document.

1. **One provider per stage.** Flip one thing, verify it, then flip the next. Two
   simultaneous flips means a failure you cannot attribute.
2. **Every stage has a rollback that takes under a minute.** If it does not, it is not
   ready to be a stage.

Supersedes the env-wiring parts of `docs/GO-LIVE.md`, which predate the sandbox
architecture and still describe `DEV_FAKE_PAYMENTS` as the local payment path.

---

## 0. Read this before you start: what is actually blocked

### Blocked on the owner — nobody can unblock these by writing code

| # | Blocker | Needed by | Notes |
|---|---|---|---|
| B1 | **A real domain.** | Stage 2 onward | Everything else hangs off it: Resend sender verification, Clerk sign-in URLs, the Stripe webhook endpoint, CORS, Apple Pay domain verification. Buy it first; DNS propagation is the longest lead time in this list. |
| B2 | **Stripe account, business-verified.** | Stage 5 | Test-mode keys are instant; **live** keys need the legal entity, an EIN or SSN, and a bank account. Budget days, not minutes. Do the test-mode half early. |
| B3 | **A lawyer reviewing the waiver, `/terms` and `/privacy`.** | Stage 8 — hard gate | The text in `apps/web/app/terms/page.tsx`, `apps/web/app/privacy/page.tsx` and the seeded waiver was drafted by an AI and **has never been reviewed by a lawyer**. It must not be described to anyone as reviewed. For a marina renting boats on a lake, the waiver is the document that matters most — it is the one that gets tested in court. This is the single item on this list that cannot be worked around. |
| B4 | **Business insurance the waiver is consistent with.** | Stage 8 | The waiver's language and the policy have to agree. The lawyer in B3 needs to see the policy. |
| B5 | **Resend account + verified sending domain.** | Stage 4 | Domain verification is DNS records on B1's domain (SPF/DKIM). |
| B6 | **Twilio account + a purchased number.** | Stage 4 | A2P 10DLC brand and campaign registration is required for US application-to-person SMS and takes days to weeks. Start it the same day you buy the domain; it will not be the thing you are waiting on if you start it early. |
| B7 | **Clerk account + a staff user per employee.** | Stage 3 | Free tier is enough for a single marina. |
| B8 | **Neon (or another managed Postgres) account.** | Stage 2 | Only if hosting off the laptop. See §1 on whether that is even the right call for one marina. |
| B9 | **A refund and cancellation policy the owner will actually honour.** | Stage 8 | The code enforces whatever cancellation window is configured; someone has to decide what it is. |
| B10 | **Real tax rates and a remittance destination.** | Stage 8 | Build-contract §5 lists tax calculation and a remittance report under Phase 1. Sonoma County rates, and who files. |

### Blocked in code — must be closed before the stage that needs them

These are from `PROVIDER-MATRIX.md` §5. They are listed here with the stage they block so
this runbook does not read as if the path is clear.

| Stage | Must be fixed first | Matrix ref |
|---|---|---|
| Stage 1 (local proof) | Payment simulator not wired to the charge path | §5.1 |
| Stage 1 | Sandbox webhook delivery 400s with no Stripe key | §5.2 |
| Stage 1 | Clock offset ignored by the reminder sweep | §5.5 |
| Stage 2 | `/health/ready` not mounted — no way to detect a sandbox-mode production deploy | §5.8 |
| Stage 3 | Admin dev-OWNER fallback fires with Clerk enforced; staff lookup hardcoded to `lsra` | §5.3 |
| Stage 4 | Errors provider has no callers — `SENTRY_DSN` changes nothing | §5.6 |
| Stage 6 | `NEXT_PUBLIC_DEMO_MODE` defaults on | §5.7 |
| Stage 6 | Customer magic link: no token table, no registered cloud sender, route unmounted | §5.4 |
| Any | No lint rule enforcing the provider seam | §5.9 |

**Stage 3's item is a security bug, not a rough edge.** A second operator's staff member
who signs in with Clerk and has no staff row under `lsra` receives OWNER access to Lake
Sonoma's data. That must be fixed before Clerk is enforced with more than one tenant in
the database.

---

## 1. Decide the hosting shape first

Before any account: decide whether this deployment is **single-marina** (Lake Sonoma only)
or **multi-tenant** (Lake Sonoma plus future customers). It changes Stage 2 and Stage 3,
and changing your mind later means a data migration.

- **Single-marina.** One operator row, one Clerk org, one Stripe account, one domain. The
  hardcoded `lsra` in `apps/admin/lib/session.ts` is survivable. Simplest path to first
  revenue.
- **Multi-tenant.** Host-based operator resolution, per-operator Stripe Connect or
  per-operator `Integration` rows, and the Stage 3 code fix is mandatory. This is where
  the product is going, and every seam in the matrix was built for it — but it is not the
  path to Lake Sonoma taking money in the next two weeks.

**Recommendation: go live single-marina, and keep the multi-tenant seams intact.** They
cost nothing to keep. Nothing in this runbook forecloses the second path.

Second decision: **the API host.** The two Next apps go to Vercel (`docs/DEPLOY.md`). The
Hono API is a long-running process and needs Railway, Render, Fly, or a small VM. It also
needs a **fixed public URL for the Stripe webhook** and, once the reminder sweep is
scheduled, a scheduler. Serverless is a poor fit here: the rate limiter's state is in
process memory (`PROVIDER-MATRIX.md` §5.11), so a serverless API silently stops rate
limiting.

---

## 2. Stage order at a glance

```
0  Baseline          make the local sandbox explicit          no accounts
1  Local proof       every payment outcome, locally           no accounts
2  Database          WSL Postgres -> Neon                     B8
3  Staff auth        dev OWNER -> Clerk                       B7
4  Messaging         sandbox inbox -> Resend + Twilio         B5 B6
5  Payments (test)   simulator -> Stripe TEST                 B2
6  Customer portal   demo catalog -> real API, real domain    B1
7  Observability     console -> Sentry, cron, backups         —
8  Legal + policy    waiver / terms / privacy / tax           B3 B4 B9 B10
9  Live keys         Stripe TEST -> LIVE                      B2
10 First real sale   one booking, watched end to end          —
```

Stages 2–5 can overlap once each is verified, but do not flip two in the same deploy.

---

## Stage 0 — Baseline: make the sandbox explicit

**No accounts needed.** Everything today runs on the *implicit* branch of the sandbox rule
(`NODE_ENV !== 'production'`), because `SANDBOX` is in no env file. Make it explicit
before you change anything else, so that later "did the flip take?" has an answer.

**Do.** Add to `.env` (and to `.env.example` / `.env.local.example` as the documented
default):

```
SANDBOX="local"
NEXT_PUBLIC_DEMO_MODE="0"
```

> *File ownership note: `.env` and the templates are outside this document's scope. This
> is the change to request, not a change made here.*

**Verify.**
- `pnpm dev:local` starts, and `/dev` on the admin app (`:3002`) loads all six tabs.
- The Inbox tab shows the seeded season's messages.
- `curl -s localhost:3000/ | grep -c 'Simulated payments'` returns `0`.

**Rollback.** Remove the two lines. Behaviour is identical, because the fallback already
resolves the same way outside production.

---

## Stage 1 — Local proof: every payment outcome, no accounts

This is build-contract §0's acceptance test and the whole reason the architecture exists.
**Do not proceed past this stage until it passes.** Going live on a payment path whose
failure modes have never been exercised is exactly what the local-first constraint was
built to prevent.

**Blocked on code:** matrix §5.1, §5.2, §5.5.

**Do, in the Local Console at `/dev`:**

| # | Action | Expected |
|---|---|---|
| 1 | Payments tab → queue `SUCCEEDED` → book and pay on `:3000` | order `PAID`, balance 0, ledger balances |
| 2 | Queue `REQUIRES_ACTION` → book | 3DS challenge surfaces; confirm it in the console; order completes |
| 3 | Queue `DECLINED` (`insufficient_funds`) → book | clean decline, retry offered, **no half-created order** |
| 4 | Queue `TIMEOUT` → book | caller sees an error, the attempt row is `SUCCEEDED` and `timedOut` |
| 5 | Replay step 4's booking with the **same** idempotency key | the existing order comes back — **not a second charge** |
| 6 | Queue `SUCCEEDED` with `captureAmountCents` < total | partial capture; balance due is correct |
| 7 | Refund it partially, then fully | refund rows correct; ledger balances after each |
| 8 | Queue `DISPUTED` on a past success | chargeback lands; order reflects it |
| 9 | Webhooks tab → replay one event | replay is a **new** row citing `replay_of_id`; the original is untouched |
| 10 | Inbox tab | confirmation email **and** SMS present, fully rendered, correct branding |
| 11 | Clock tab → +24h → run the reminder sweep | the reminder fires and lands in the Inbox |
| 12 | Reset tab | back to the seed, counts shown before the wipe |

**Verify.** `pnpm verify` green — and read the output, do not just check the exit code.

**Rollback.** N/A; nothing external has changed.

**If step 5 or step 11 cannot be performed**, stop and fix the code (§5.1, §5.5). Step 5
is the one that protects against double-charging a real customer, and step 11 is the one
that proves reminders will ever go out.

---

## Stage 2 — Database: WSL Postgres → Neon

**Needs: B8.** Skip entirely if hosting Postgres yourself.

**Do.**
1. Create the Neon project. Take **both** connection strings: pooled and direct.
2. Set `DATABASE_URL` (pooled) and `DIRECT_URL` (direct, no pgbouncer).
3. `pnpm db:migrate:deploy` — applies migrations. Then `pnpm db:rls`.
4. `pnpm db:approle` — creates the NOBYPASSRLS `app_user`. Set `APP_DATABASE_URL` to that
   role's pooled string and `APP_DB_PASSWORD` if the URL references it.
5. Seed: `pnpm db:reset` for a demo tenant, or seed only the real operator for production.
6. Set all four variables on **both** the API host and the Vercel `marina-admin` project.
   The admin app queries the database directly (D-007) and will 500 without them.

**Verify.**
- `pnpm --filter @marina/database test` — `tenant-isolation.test.ts` passes against Neon.
- `psql "$APP_DATABASE_URL" -c "select rolbypassrls from pg_roles where rolname=current_user"` prints `f`. **If it prints `t`, or `APP_DATABASE_URL` is unset, RLS is not enforced** and only a line on stdout says so (`packages/database/src/client.ts:43`).
- The API's startup log contains no `APP_DATABASE_URL not set` warning.
- `curl -s https://<api-host>/api/whoami -H 'x-operator-slug: lake-sonoma'` returns the operator id.

**Rollback.** Point the four vars back at the local strings and restart. Nothing has been
deleted; the WSL cluster is untouched.

**Watch for.** Prisma migrations through pgbouncer fail in confusing ways — that is what
`DIRECT_URL` is for. Neon cold starts add latency to the first request after idle; the
readiness probe's default 2s timeout (`HEALTH_TIMEOUT_MS`) may need raising.

---

## Stage 3 — Staff auth: dev OWNER → Clerk

**Needs: B7. Blocked on code: matrix §5.3.**

**Do.**
1. Clerk application → copy `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.
2. Configure sign-in / sign-up URLs in the Clerk dashboard to match
   `NEXT_PUBLIC_CLERK_SIGN_IN_URL` (`/sign-in`) etc.
3. Create one Clerk user per employee.
4. **Before enforcing**, create the matching `StaffMember` rows — `auth_user_id` = the
   Clerk user id, `is_active` = true, correct role. A Clerk user with no staff row is what
   triggers the §5.3 fallback.
5. Set `PLATFORM_ADMIN_AUTH_IDS` to the owner's Clerk user id.
6. Only now: `REQUIRE_CLERK_AUTH=true` on the admin app **and** the API. Redeploy the
   admin app — `NEXT_PUBLIC_*` values are inlined at build time.

**Verify.**
- Private window → `https://admin.<domain>/` redirects to `/sign-in`.
- After sign-in, the header shows the **real staff name**, not `dev-owner`. This is the
  check that catches §5.3; the redirect alone does not.
- `curl -s -o /dev/null -w '%{http_code}' https://<api-host>/api/orders -H 'x-operator-slug: lake-sonoma' -H 'x-dev-staff-id: anything'` returns **401**.
- Sign in as a non-owner staff user and confirm a `operator:manage` action is refused.

**Rollback.** `REQUIRE_CLERK_AUTH=false` and redeploy. Both apps return to the dev
fallback immediately — which is exactly why this variable, not `SANDBOX`, is the auth
master switch, and why it must never be left `false` in production.

**Watch for.** The API reads `CLERK_SECRET_KEY` at module load; a key change needs a
restart, not a reload. Remove `x-dev-staff-id` from the CORS `allowHeaders` list
(`apps/api/src/app.ts:75`) once enforcement is on.

---

## Stage 4 — Messaging: sandbox inbox → Resend + Twilio

**Needs: B5, B6.** Do email and SMS as two separate flips.

### 4a. Email

1. Resend → add and verify the sending domain (DNS on B1's domain).
2. Set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` (an address on the verified domain).
   **The default is `bookings@notifications.marina.app`, a domain nobody here owns** — an
   unset `RESEND_FROM_EMAIL` means every send is rejected.
3. `SANDBOX=cloud` on the API.

**Verify.** Make one booking. The confirmation arrives in a real inbox; branding, dates
and the order number are correct; the reply-to is the operator's address. Then:
`psql "$DATABASE_URL" -c 'select count(*) from "SandboxMessage"'` — the count must **not**
have moved.

**Rollback.** `SANDBOX=local`, restart. Messages go back to the sandbox inbox and no
customer sees anything.

**Watch for.** `SANDBOX=cloud` with a missing or wrong `RESEND_API_KEY` does not throw —
the booking succeeds and the email is silently `skipped`. The only signal is a stdout
line. Check the log after the first live booking, every time.

Note the multi-tenant gap: the from-address is **global**, unlike Twilio's per-operator
`Integration`. For a single marina this is fine. For a second tenant it means their mail
leaves from your domain with only the display name white-labelled.

### 4b. SMS

1. Twilio → buy a number, complete A2P 10DLC registration (**start this early**, B6).
2. Preferred: create an `Integration` row for the operator, `key='twilio'`,
   `enabled=true`, config `{account_sid, auth_token, from_number}`. This is the
   multi-tenant path and it already works.
3. Or set `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` as the
   single-tenant fallback.

**Verify.** Book with a real mobile number; the text arrives; `SandboxMessage` shows no
new `SMS` row for that order.

**Rollback.** Disable the `Integration` row (or clear the env vars). Sends become
`skipped` — never an error, never a broken booking.

**Watch for.** `toE164` (`services/sms.ts:90`) assumes +1 for 10-digit input. A non-US
number that does not normalize is skipped silently.

---

## Stage 5 — Payments: simulator → Stripe TEST

**Needs: B2 (test keys only).** Live keys are Stage 9. Do not skip the test-mode stage —
it is where you find out that the publishable key and the secret key are two switches.

**Do.**
1. Stripe test mode → API keys.
2. API: `STRIPE_SECRET_KEY=sk_test_…`; clear `DEV_FAKE_PAYMENTS`.
3. Web: `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_…`; clear
   `NEXT_PUBLIC_DEV_FAKE_PAYMENTS`; **rebuild** (build-time inline).
4. Stripe → Developers → Webhooks → endpoint `https://<api-host>/webhooks/stripe`,
   events `payment_intent.succeeded`, `payment_intent.payment_failed`,
   `charge.refunded`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
5. `SANDBOX=cloud` on all three apps.

**Verify.** Run the same card matrix as Stage 1, using Stripe's published test cards —
they are the ones the simulator already mimics:

| Card | Expect |
|---|---|
| `4242 4242 4242 4242` | success |
| `4000 0025 0000 3155` | 3DS challenge |
| `4000 0000 0000 0002` | generic decline |
| `4000 0000 0000 9995` | insufficient funds |

Then:
- `curl -s -o /dev/null -w '%{http_code}' -X POST https://<api-host>/webhooks/stripe -d '{}'` returns **401**. A `200` means the endpoint accepts unverified events from anyone.
- Refund from the admin app; confirm the refund appears in the Stripe dashboard **and** the order's ledger balances.
- The Stripe dashboard's webhook log shows 200s, not retries.

**Rollback.** Remove `STRIPE_SECRET_KEY`, restore `DEV_FAKE_PAYMENTS=true`,
`SANDBOX=local`, redeploy the web app with the fake-payment flag. Test-mode money is not
real, so a partial rollback here costs nothing — which is the point of doing test mode as
its own stage.

**Watch for.**
- **Half a flip is worse than none.** Secret key without publishable key = checkout stays
  simulated and sends a fake `sourceId` to a real Stripe account (every charge fails
  `resource_missing`). Publishable without secret = real card collected, API returns 501.
- Every `NEXT_PUBLIC_*` change needs a **redeploy**, not a restart.
- With `STRIPE_WEBHOOK_SECRET` unset the handler accepts unverified JSON and resolves the
  tenant from the payload — an unauthenticated path that can move a real payment's status.

---

## Stage 6 — Customer portal: demo catalog → real API, real domain

**Needs: B1. Blocked on code: matrix §5.7, and §5.4 if the account portal ships.**

**Do.**
1. `NEXT_PUBLIC_DEMO_MODE=0` on the web app. **The default is demo ON** — without this,
   real customers see a fake catalog and book into their own cookie. Rebuild.
2. `API_URL` = the public API base. `OPERATOR_SLUG` = `lake-sonoma` (or resolve from host
   for multi-tenant).
3. `ALLOWED_ORIGINS` on the API = the real web and admin origins, comma-separated. Do not
   rely on the `APP_BASE_DOMAIN` fallback.
4. `APP_BASE_DOMAIN` = the real domain on all three apps.
5. If the customer account portal is going live: close §5.4 first (`CustomerAuthToken`
   model, `setMagicLinkEmailSender()` registration, mount `routes/customer-auth.ts`), then
   set `CUSTOMER_SESSION_SECRET` (**the API throws in production without it**) and
   `CUSTOMER_PORTAL_URL`.

**Verify.**
- `curl -s https://book.<domain>/ | grep -c 'Simulated payments'` returns `0`.
- The catalog on the live site matches the admin app's activity list — same names, same
  prices. If they differ, demo mode is still on.
- `curl -s -i https://<api-host>/api/whoami -H 'Origin: https://evil.example' -H 'x-operator-slug: lake-sonoma' | grep -i access-control-allow-origin` prints nothing.
- Book from a phone on cell data, not wifi. The build contract's sharpest claim is
  sub-30-second booking on bad rural service; this is the first honest test of it.

**Rollback.** Rebuild with `NEXT_PUBLIC_DEMO_MODE` unset — the site returns to the
self-contained demo and takes no real bookings. That is a genuinely safe failure state,
and worth keeping as the emergency stop for the web app.

---

## Stage 7 — Observability, scheduling, backups

**No new accounts except Sentry, which is optional.**

**Do.**
1. **Mount `routes/health.ts`** (matrix §5.8) and remove the stub `GET /health` in
   `app.ts:81`. Point the host's health check at `/health/live` and the load balancer's at
   `/health/ready`. `/health/ready` already reports `degraded` when a production process is
   still on the sandbox drivers — that is the single most valuable probe in this runbook,
   and it is currently unreachable.
2. **Set `CRON_SECRET`** and schedule `POST /internal/reminders/run` (hourly is
   reasonable). **With `CRON_SECRET` unset the endpoint is open to the internet**
   (`routes/internal.ts:25`).
3. **Sentry** (optional): wire `captureError` into `app.onError` (§5.6) — without that,
   setting `SENTRY_DSN` changes nothing — then set `SENTRY_DSN`, `SENTRY_ENVIRONMENT`,
   `SENTRY_RELEASE`.
4. **Backups.** Enable Neon PITR (or `pg_dump` on a schedule). Then do the thing that
   matters: **run a restore drill** into a scratch database and confirm the data is
   really there. Build-contract §9 asks for a restore drill, not a backup setting. A
   backup nobody has restored is a belief, not a backup.

**Verify.**
- `curl -s https://<api-host>/health/ready | jq '.status, .checks.sandbox'` → `"ok"` and mode `cloud`. Anything reporting `local` in production means a payment or email driver is still simulated.
- `curl -s -o /dev/null -w '%{http_code}' -X POST https://<api-host>/internal/reminders/run` with no auth → **401**.
- A restored copy of the backup contains yesterday's orders.

**Rollback.** Each item is independent and individually revertible.

---

## Stage 8 — Legal, policy, tax — the hard gate

**Needs: B3, B4, B9, B10. Nothing here can be closed by writing code.**

| Item | State today | Needed |
|---|---|---|
| Liability waiver | AI-drafted, seeded, **never legally reviewed** | Lawyer review against B4's policy. This is the document that gets tested when someone is hurt on the water. |
| `/terms` | AI-drafted (`apps/web/app/terms/page.tsx`) | Lawyer review |
| `/privacy` | AI-drafted (`apps/web/app/privacy/page.tsx`) | Lawyer review; must match what is actually collected and who it is shared with (Stripe, Clerk, Resend, Twilio, Sentry) |
| Refund / cancellation policy | configurable, undecided | Owner decides; must match what `/terms` says |
| Tax | build-contract §5 lists calculation + remittance as Phase 1 | Real Sonoma County rates; who files |
| Data deletion requests | build-contract §9 | A documented process, even if manual |

**Never describe the drafted text as reviewed.** The only acceptable states are "reviewed
by <name> on <date>" or "not yet reviewed."

**Verify.** The lawyer's sign-off, in writing, naming the version of each document.

**Rollback.** N/A — this stage is a gate, not a flip.

---

## Stage 9 — Stripe TEST → LIVE

Do this **last**, and only after Stage 8 has actually cleared. Once live keys are in,
mistakes cost real money and real chargebacks.

**Do.**
1. Complete Stripe business verification (B2) — legal entity, tax id, bank account.
2. Swap `STRIPE_SECRET_KEY` to `sk_live_…` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` to
   `pk_live_…`. Rebuild the web app.
3. **Create a new webhook endpoint in live mode.** Live and test endpoints are separate
   objects with **different signing secrets**. Update `STRIPE_WEBHOOK_SECRET`.
4. Confirm the Stripe payout schedule and destination bank account.

**Verify — with the owner's own card, then refunded:**
- One real booking for the smallest bookable amount.
- Confirmation email and SMS arrive.
- The charge appears in the live Stripe dashboard; the webhook log shows a 200.
- Refund it from the admin app; the refund appears in Stripe **and** the order's ledger
  balances.
- The order's `Payment` row's `processor_transaction_id` matches the Stripe PaymentIntent id.

**Rollback.** Swap back to test keys and the test webhook secret. Any real charge already
taken must be refunded manually in the Stripe dashboard — the app's refund path is the
better route, but the dashboard is the backstop.

---

## Stage 10 — First real sale

Watch one real customer's booking end to end, live, with the admin app open. Not a test
booking — the first real one.

Check, in order: order created → payment `PAID` → confirmation email → confirmation SMS →
the booking on the manifest → check-in on the dock → the day's accounting export
reconciling against the Stripe payout.

That last one is the real proof. Everything before it is a component test.

---

## Go / no-go checklist

Every line must be **verified by running the check**, not by reading the config. This is
build-contract §3.6: run the command, read the output.

### Money

- [ ] Stage 1's twelve local outcomes all pass, including double-submit idempotency
- [ ] Stripe **live** keys set on API and web; `DEV_FAKE_PAYMENTS` and `NEXT_PUBLIC_DEV_FAKE_PAYMENTS` are **gone**
- [ ] `STRIPE_WEBHOOK_SECRET` is the **live** endpoint's secret; unsigned POST returns 401
- [ ] One real charge taken and refunded; the ledger balanced after each
- [ ] Stripe payout destination confirmed
- [ ] Tax rates configured; a remittance report produced for one real day
- [ ] The day's accounting export reconciles against the Stripe payout

### Isolation and access

- [ ] `APP_DATABASE_URL` set; `rolbypassrls` is `f`; no `APP_DATABASE_URL not set` warning in the API log
- [ ] `pnpm --filter @marina/database test` green against production Postgres
- [ ] `REQUIRE_CLERK_AUTH=true` on both admin and API
- [ ] Signed-in admin header shows a real staff name, **never** `dev-owner`
- [ ] Matrix §5.3 fixed if more than one operator exists in the database
- [ ] `x-dev-staff-id` returns 401
- [ ] `PLATFORM_ADMIN_AUTH_IDS` set to real Clerk ids
- [ ] `ALLOWED_ORIGINS` explicit; a foreign Origin gets no CORS header

### Not-still-a-sandbox

- [ ] `SANDBOX=cloud` on **all three** apps (they read it independently)
- [ ] `/health/ready` mounted and reporting `sandbox: cloud`, status `ok`
- [ ] `NEXT_PUBLIC_DEMO_MODE=0` on web, and the live catalog matches the admin app's
- [ ] `SandboxMessage` stops growing while real bookings arrive
- [ ] `select offset_seconds from "SandboxClock"` is empty or all zero
- [ ] No `QUEUED` rows left in `SandboxPaymentAttempt`
- [ ] `/dev` returns **404** on the production admin app

### Delivery

- [ ] Resend domain verified; `RESEND_FROM_EMAIL` set to an address on it
- [ ] A real confirmation email received, correct branding
- [ ] Twilio A2P registration approved; a real SMS received
- [ ] `CRON_SECRET` set; unauthenticated sweep POST returns 401
- [ ] The reminder sweep is scheduled and has fired at least once
- [ ] A reminder actually reached a customer

### Trust

- [ ] Waiver, `/terms`, `/privacy` reviewed by a lawyer — **name and date recorded**
- [ ] Business insurance in force and consistent with the waiver
- [ ] Refund/cancellation policy decided, configured, and matching `/terms`
- [ ] Backups enabled **and a restore drill completed**
- [ ] Error capture wired and reaching Sentry (or accepted as console-only, in writing)
- [ ] Audit log recording money-touching actions
- [ ] A data-deletion request process exists, even if manual

### Rollback readiness

- [ ] Every stage's rollback has been rehearsed at least once
- [ ] The previous deploy of each app can be restored from the host's UI
- [ ] Someone other than the owner knows where the env vars live and how to flip `SANDBOX` back

---

## The emergency stop

If something is badly wrong after go-live and you need to stop taking money **now**:

1. **Remove `STRIPE_SECRET_KEY` from the API and restart.** Every charge endpoint returns
   a clean `501 payments not configured`. Bookings that do not require payment still work;
   nothing is half-created.
2. If the site itself is wrong, rebuild the web app **without** `NEXT_PUBLIC_DEMO_MODE=0`
   — it falls back to the self-contained demo and takes no real bookings.

Do **not** reach for `SANDBOX=local` as the emergency stop. It would silently route real
customers' confirmation emails into the sandbox table while the site kept taking bookings
— quiet, and worse than a loud 501.

---

## TL;DR

Ten stages, one provider each, every one reversible in under a minute. The four things
that will actually bite: `NEXT_PUBLIC_DEMO_MODE` defaults to a fake catalog, the Stripe
secret and publishable keys are two separate switches, the admin app falls back to OWNER
access even with Clerk enforced, and the payment simulator that Stage 1 depends on is not
wired to the charge path yet. The one thing no amount of code can fix is B3 — a lawyer
reading the waiver, `/terms` and `/privacy` before a customer signs anything.
