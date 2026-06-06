# Progress Log

> Running log so the owner can glance in anytime. Newest at top. Plan lives in
> [`ROADMAP.md`](ROADMAP.md); board in [`TASKS.md`](TASKS.md); decisions in
> [`docs/DECISIONS.md`](docs/DECISIONS.md).

## 2026-06-06 — Phase 3: money robustness + go-live hardening (COMPLETE)

- Made the API **production-safe**, on branch `phase-3-golive` (stacks on phase-2; staged
  locally, not pushed). Owner-blocked bits (live Stripe, billing charging, Vercel, legal)
  built dark-and-ready.
- **Team of 3 Sonnet agents + my wiring/integration:** (A) observability — structured JSON
  logs + `x-request-id`, safe error envelopes via `app.onError`, `captureError` APM seam,
  `/ready` DB ping; (B) payments — 3DS/SCA done right (`requires_action + clientSecret` +
  `/payments/confirm`, closing D-013) + `Idempotency-Key` passthrough (B also fixed a latent
  bug: web `submitPayment` hit a non-existent endpoint); (C) security — in-memory rate limiter
  (signup/slug/OTP/booking) + security headers.
- **I wired** the middleware into app.ts/signup.ts (reserved shared files), fixed 2 type
  errors from the agents (a context-var cast → typed `Env.requestId`; a Stripe success literal),
  and wrote `PRODUCTION_READINESS.md` (the go-live runbook + pre-launch gate).
- **Live-verified vs Neon:** `/ready`→`{ok,db:up}`; 401/404 safe envelopes + `x-request-id` +
  security headers; signup `5×201 → 429 (Retry-After 53)`; **isolation 8/8**. typecheck 9/9;
  api + web build green. Test operators cleaned up. Decisions D-034, D-035.
- **Remaining (owner):** live Stripe 3DS/charge verify, per-tenant billing charging, Vercel
  deploy, Neon restore drill, legal/ToS. **Next: whatever the owner prioritizes** — deepen
  Phase 2 (Clerk-on signup/billing) or Phase 4 polish.

## 2026-06-06 — Phase 2: the self-serve front door (COMPLETE)

- **A stranger can now create a tenant with zero manual DB work**, on branch
  `phase-2-frontdoor` (staged locally, not pushed — Vercel quota).
- **Foundation (me):** `provisionOperator` + `POST /signup` + `/signup/slug-available`
  (pre-tenant, adminPrisma, outside tenant mw). Live-verified: slug free/taken/reserved,
  201 provision, new tenant resolves by its slug, **isolation holds (fresh owner → 403 on
  seed; suite 8/8)**. Dev-context cookie (`mb_dev_operator`) wired into `getOperatorContext`
  so a dev signup actually becomes the active tenant. D-032.
- **Team of 3 Sonnet agents (parallel):** (A) public admin `/signup` UI with live slug
  check → provision → cookie → onboarding; (B) onboarding now creates rate + 21d of
  timeslots + visible_online → a genuinely bookable storefront; (C) web `getBrand()` async,
  resolves from `/api/operator/public` not env. I integrated + fixed a white-label leak (the
  layout's static title → async `generateMetadata` off the operator brand). D-033.
- **Live-verified:** admin renders ALL routes 200 as a brand-new EMPTY tenant (graceful empty
  states, "Tomales Bay Kayaks" + "No activities yet"); storefront title/header = "Lake Sonoma
  Marina" (from operator), zero env leak. typecheck 9/9; admin build green (27 routes incl.
  `/signup`); web build green. Test operators cleaned up.
- **Remaining (noted):** wizard→storefront click-through is a browser pass; Clerk-on signup +
  public-prod abuse protection (rate limit/captcha) + per-tenant billing are follow-ups.
- **Next:** Phase 3 (money & go-live) or deepen Phase 2.

## 2026-06-06 — Founder takeover: oriented, planned, building

- **Read the whole project** (shared-brain docs + 26 decisions + the actual
  frontend tree). Verified the floor myself: **typecheck 9/9 green**, **core
  money-math 69/69 green**. Live integration suite (167) is green-on-record and
  runs when `.env` is exported (it auto-skips otherwise — confirmed it's a
  skip-not-fail). `.env` now carries Clerk secret + Resend keys; Stripe keys still
  absent (payments stay in the clean 501 path — owner-blocked).
- **Wrote the founder cockpit docs:** `VISION.md` (the read + the bar),
  `ROADMAP.md` (Phase 1 cockpit → Phase 2 front door → Phase 3 money/go-live →
  Phase 4 polish, plus an IMPROVEMENTS backlog), `TASKS.md` (Phase 1 broken down),
  this log. Logged the meta-decisions as D-027 (cockpit docs + branch/PR-vs-Vercel
  posture) and D-028 (Phase 1 = wire the cockpit).
- **The honest read:** the backend is a Ferrari engine; the gap to "fully
  functional and sellable" is the cockpit (proven backend with no UI), the front
  door (no self-serve operator signup), and go-live ops (partly owner-blocked).
  Phase 1 wires the cockpit.
- **Branch `phase-1-cockpit`** created for the phase (clean PR per phase; staged
  locally, not pushed — pushing auto-deploys and burns the Vercel quota the owner
  flagged, D-027).
- **✅ Task 1.1 — Customer email-OTP login UI (shipped).** New `/login` two-step
  passwordless screen over the live-verified D-017 backend; httpOnly session cookie
  (`lib/session.ts`); session-aware account area (signed-in banner + sign-out +
  passwordless CTA, lookup kept as fallback with email prefilled); API client gained
  the auth calls + bearer forwarding so self-service reschedule authenticates by token.
  **Fixed a live bug:** the header's "My Booking" → `/lookup` was a 404 (no such
  route) → repointed to `/account` + added "Sign in". Verified: web typecheck clean +
  production build green (9 routes). **0.7 is now fully ✅.** Browser E2E deferred to
  the 1.8 verification pass (stand the stack up once, smoke everything together).
- **✅ Tasks 1.2–1.7 — Cockpit sweep (shipped).** Surfaced 5 backend pillars in the
  admin UI: **Gift Cards**, **Resources/Assets** (the moat), **Waiver Templates**
  (Settings), **Reports** By-Location + Accounting tabs, and **POS gift-card tender**.
  Built a shared admin→API client (`apiClient.ts`) + logged **D-029** (admin management
  calls the live-tested API so money/capacity invariants aren't duplicated). Used 5 lean
  parallel Sonnet agents, then did the integration pass myself: fixed an invalid
  `'PENDING'` order status and a client/server-boundary import (shell barrel → leaf).
  Verified: **typecheck 9/9, admin build green (26 routes), web build green.**
- **✅ Task 1.8 — Live verification (Phase 1 COMPLETE).** Stood the full stack up
  against Neon — first time the frontend was actually *run*. Findings + fixes:
  - **Admin→API seam was broken:** tenant middleware only resolved `x-operator-slug`/Host,
    so admin calls 400'd. Fixed with a validated `x-operator-id` server-to-server path
    (**D-030**); re-ran **isolation 8/8 live** (no regression). Re-seeded the Neon dev
    tenant for the `dev-owner` staff. Then smoked all 5 admin endpoints (200) + a live
    gift-card write + correct 401/404 negatives.
  - **Touched API suites live: 35/35.** **Every route renders 200** — admin 21/21, web all
    (incl. real activity detail).
  - **Caught + fixed 2 pre-existing 500s** the build couldn't catch (FE never run before):
    `/activities` (cell functions → client DataTable) and `/settings` (mapped a client
    export server-side). **D-031.** Zero broken routes now.
  - **Customer login loop verified live** (request → devCode → verify → token, single-use).
  - typecheck 9/9, both apps build, servers torn down.
- **Decisions logged:** D-029 (admin→API), D-030 (tenant x-operator-id), D-031 (RSC boundary).
- **Next:** Phase 2 — the self-serve operator front door (public signup → provision tenant
  → guided onboarding → live bookable storefront).
