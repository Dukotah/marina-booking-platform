# Production Readiness & Go-Live Runbook

> What it takes to run this safely in production, what's done, and what's still
> owner-gated. Phase 3 hardened the parts that don't need owner accounts; the
> remaining items need external services the owner provisions. Pair with the
> go-live checklist in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Status at a glance

| Area | State |
|---|---|
| Tenant isolation | ✅ 3-layer (FK + RLS non-bypass role + composite FKs), live suite 8/8 |
| Money correctness | ✅ integer cents, ledgered gift cards, refunds; ⏳ live Stripe charge needs keys |
| 3-D Secure / SCA | ✅ code-complete (D-035); ⏳ verify with live Stripe keys |
| Payment idempotency | ✅ client `Idempotency-Key` → Stripe (no double-charge) |
| Observability | ✅ structured request logs + request-id; error-monitoring **seam** (wire an APM SDK at `captureError`) |
| Health / readiness | ✅ `GET /health` (liveness) + `GET /ready` (DB ping) |
| Rate limiting / abuse | ✅ in-memory limiter on signup / slug-check / OTP / booking (⚠️ per-instance; Redis when scaled) |
| Security headers | ✅ nosniff / frame-deny / referrer / cross-domain on the API |
| Zero broken routes | ✅ admin + web smoke 200 across all routes |
| Backups / DR | ⏳ Neon PITR (verify retention + a restore drill) |
| Deploy | ⏳ owner — Vercel (web/admin) + Railway/Render (API); fix any deploy-log issues |
| Per-tenant billing | ⛔ deferred — needs Stripe Billing/Connect (owner) |
| Legal (waiver review, ToS, privacy) | ⛔ owner |

## Required environment / secrets (production)

API (Railway/Render):
- `DATABASE_URL` (owner/migrations) + `APP_DATABASE_URL` (the **NOBYPASSRLS** `app_user` — RLS only bites a non-owner role; see D-010)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — enables charges + 3DS + signed webhooks
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL` — transactional email + OTP + reminders
- `CUSTOMER_AUTH_SECRET` — **must** be set in prod (fails closed; D-017)
- `JOBS_SECRET` — gates `POST /jobs/*` (reminder cron); fail-closed in prod (D-019)
- `REQUIRE_CLERK_AUTH=true` + `CLERK_SECRET_KEY` — enforce staff/operator auth (D-012)
- `ERROR_DSN` (or `SENTRY_DSN`) — turns on error capture (and wire an APM SDK at `captureError`)

Web/Admin (Vercel):
- `API_URL` / `API_BASE_URL`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, Clerk publishable key,
  `OPERATOR_SLUG` (dev/default tenant), `INTERNAL_API_TOKEN` (optional admin→API bearer)

Posture: every external service degrades gracefully when unset (clean 501 / no-op /
dev-fallback) so the app boots without them — production flips them on.

## Observability

- **Request logs:** one structured JSON line per request — `requestId`, method, path, status,
  `durationMs`, `operatorId`. Every response carries `x-request-id` for correlation.
- **Errors:** `app.onError` maps known error classes (auth → 403, typed service errors →
  their status + code) and returns a **safe** `500 {error, requestId}` for anything else —
  no stack/message leak. `captureError` is the APM seam: set `ERROR_DSN` and drop a
  `Sentry.captureException` (or equivalent) call in `middleware/observability.ts`.
- **Health gates:** point the platform's liveness at `/health`, readiness at `/ready`.

## Security / abuse

- Rate limits (per-instance, in-memory; swap for Redis/Upstash when running >1 instance):
  signup 5/min, slug-check 30/min, customer-OTP 5/min, booking 20/min — `429` + `Retry-After`.
- Public signup in prod is **Clerk-gated** (the OWNER id must come from a verified token;
  body value ignored). Consider adding a captcha for extra abuse resistance.
- Security headers set on every API response.

## Backups & DR (Neon)

- Neon provides point-in-time restore; **action:** confirm the retention window on the prod
  branch and run one **restore drill** (branch → verify → discard) before launch.
- Migrations: `pnpm db:migrate:deploy` (never `migrate dev` in prod). RLS + app-role setup
  (`db:rls`, `db:approle`) are idempotent and must be re-run after adding tenant tables.

## Deploy (owner)

- Web + Admin → Vercel; API → Railway/Render. Admin build runs `prisma generate` first and
  pins the `rhel-openssl-3.0.x` engine target (the earlier Linux deploy fix). Set all env
  above; run readiness checks post-deploy. Custom-domain / subdomain white-label: map the
  tenant host → operator (brand already resolves from the operator, D-033).

## Pre-launch checklist (the gate)

- [ ] All prod env/secrets set (above)
- [ ] `APP_DATABASE_URL` is the NOBYPASSRLS role; isolation suite green against prod
- [ ] Stripe live: a real charge, a 3DS card, and a refund all verified end-to-end
- [ ] `REQUIRE_CLERK_AUTH=true` + a real OWNER staff user created
- [ ] Error monitoring (DSN + SDK) receiving events; logs queryable
- [ ] `/ready` wired to the deploy health gate; reminder cron hitting `/jobs/reminders`
- [ ] Neon backup retention confirmed + one restore drill done
- [ ] Waiver text legally reviewed; ToS + privacy published
- [ ] A fresh operator signs up → onboards → takes a live booking on their branded storefront
