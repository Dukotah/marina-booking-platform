# Local-First Build Contract — beat Singenuity & FareHarbor

**This document is the operating contract for building this product to completion.**
Every session working on this repo reads this file first, picks up at the current
phase, and holds to the rules below. It supersedes `docs/ROADMAP.md` for sequencing
and sits alongside `docs/NORTHSTAR-ROADMAP.md` (which holds the competitive analysis).

Owner: runs Lake Sonoma Marina. The product must be good enough to run his marina on,
and good enough to sell to marinas currently paying Singenuity or FareHarbor.

---

## 0. The one hard constraint

> **The owner must be able to exercise 100% of this product on his own machine
> without creating an account with anybody.**

No Neon. No Stripe. No Clerk. No Resend. No Twilio. No Cloudflare. No Sentry.
No Docker. If a feature cannot be demonstrated end-to-end on this laptop with zero
signups, **the feature is not done.**

This is not a testing shortcut — it is an architectural requirement. It forces every
external dependency behind an interface with two drivers: `local` and `cloud`. That
seam is what makes the product multi-tenant and sellable anyway (operators bring their
own Stripe/Twilio), so the constraint costs nothing and buys everything.

**The corollary, which matters just as much:** a local driver must be a faithful
simulation, never a toy. If Stripe can throw a 3DS challenge, the local payment driver
throws a 3DS challenge. If Twilio can fail, the local SMS driver can be told to fail.
We are testing the real state machine, not the happy path.

---

## 1. Ground truth about this machine (verified 2026-08-26)

Do not re-litigate these. They were checked, not assumed.

| Fact | Detail |
|---|---|
| **Postgres** | **Already installed and working** — Postgres 18 in WSL Ubuntu 26.04. Start with `wsl -d Ubuntu -- bash -lc "sudo pg_ctlcluster 18 main start"`. Listens on 127.0.0.1:5432 and **is reachable from Windows** (WSL2 localhost forwarding). Passwordless sudo. |
| **Database state** | `marina` DB exists, roles `marina` + `app_user` exist, 39 tables migrated, RLS applied, seeded (22 activities). `.env` already points at it. |
| **Test state** | **111/111 pass live** — 69 `@marina/core`, 34 `@marina/api`, 8 tenant-isolation. Zero skips when the cluster is running. |
| **Docker** | Not installed. Do not require it. |
| **Smart App Control** | **Enforcing.** Unsigned Windows executables are blocked (this is why `embedded-postgres`-style downloads fail). Never suggest disabling it — it is irreversible. Use WSL for anything needing an unsigned binary. |
| **NODE_ENV** | Never pin it in `.env`. `next dev` and `next build` each set it themselves; a pinned `development` makes `next build` render with React's dev bundle and fails the /404 + /500 export with a misleading `<Html> should not be imported outside of pages/_document`. Fixed in 32bb36a. |
| **Two clones** | There is a second clone at `\\wsl.localhost\Ubuntu\home\dukotah\marina-booking-platform`. It once held ~12k lines of uncommitted work (recovered in 9efd44d). Check it before assuming something was never built. |
| **pnpm** | **Not on PATH.** Every PowerShell command must be prefixed with `$env:PATH = "C:\Program Files\nodejs\node_modules\corepack\shims;$env:PATH"`. Fixing this permanently is a Phase 0 task. |
| **Broken installs** | If tsc reports `Cannot find type definition file for 'node'` or pnpm throws `EACCES`, the per-package `node_modules` junctions have gone dangling. Fix: `rmdir /s /q` each `apps/*/node_modules` and `packages/*/node_modules`, then `pnpm install`, then `pnpm db:generate`. |
| **Deploys** | Both Vercel projects have an "Ignored Build Step" that cancels every git push. CLI deploys (`vercel deploy --prod --yes`) bypass it. Do not assume a push deployed anything. |

---

## 2. The competitive bar

We are not building "a booking form." Three things decide whether an operator switches:

1. **Does it run my day?** The manifest, dispatch, check-in, walk-ups, and refunds have
   to be faster than what they do now. Singenuity makes operators use three separate
   apps; our whole edge is one screen.
2. **Does it make me more money?** Higher booking conversion, upsells, gift cards,
   memberships, dynamic pricing, and channel distribution. FareHarbor's real lock-in is
   distribution, not software.
3. **Can I put it on my own website?** FareHarbor wins deals on its embeddable booking
   widget. An operator who cannot embed us will not switch. This is a **must-ship**, not
   a nice-to-have.

And one thing decides whether their customers are happy: **booking has to take seconds
on bad rural cell service.** That is our sharpest differentiator, because both
incumbents' flows are dated and heavy.

Every feature below is judged against those four sentences.

---

## 3. Definition of Done

A feature is done when **all six** are true. Five out of six is not done.

1. It works against the live local Postgres, not fixtures.
2. It has automated tests — unit for logic, integration for the data path, and an
   end-to-end browser test for anything a human touches.
3. Realistic seed data exists so the feature looks real on a dashboard, not empty.
4. It is visible and exercisable from the **Local Console** (§4) with no external account.
5. The cloud swap is documented — which env vars turn the local driver into the real one.
6. `pnpm verify` is green, and you **ran it and read the output**.

> **Never report a feature complete without having run it.** If a check was skipped,
> say which one and why. A green claim that turns out to be untested costs more trust
> than an honest "this part is unverified."

---

## 4. Phase 0 — The Local Sandbox (build this first, nothing else matters yet)

Everything downstream depends on being able to test without accounts. Build the seam.

### 4.1 Provider layer

Create `packages/providers` with an interface plus two drivers per concern, selected by
a single `SANDBOX=local|cloud` env with per-provider overrides:

| Provider | `local` driver | `cloud` twin |
|---|---|---|
| `payments` | Scriptable simulator: succeed, `requires_action` (3DS), decline, network timeout, partial capture, refund, chargeback. Emits the same webhook shapes Stripe does. | Stripe |
| `email` | Writes to a `SandboxMessage` table and renders the real template | Resend |
| `sms` | Same sink, `channel = 'sms'` (extend the existing `sms.ts` — it already no-ops cleanly) | Twilio |
| `storage` | Local disk under `.sandbox/uploads`, served by a route | Cloudflare R2 |
| `auth` | Local magic-link: the link lands in the sandbox inbox | Clerk |
| `clock` | Injectable time so reminders and sweeps are testable without waiting | System time |
| `errors` | Local error table plus console | Sentry |

Rule: **no application code may import Stripe/Resend/Twilio directly.** It imports the
provider interface. A lint rule should enforce this.

### 4.2 The Local Console

A `/dev` area in `apps/admin`, hard-gated behind `SANDBOX=local` (it must 404 in cloud
mode — prove that with a test). It shows:

- **Inbox** — every email and SMS the system sent, fully rendered, newest first.
- **Payments** — every attempt and its state machine, with buttons to force the next
  outcome (approve / challenge / decline / time out) before you check out.
- **Webhooks** — what fired, with replay.
- **Clock** — jump forward N hours to make reminders fire; run any sweep on demand.
- **Errors** — what threw, with the stack.
- **Reset** — wipe back to a known seed in one click.

This console *is* the owner's testing surface. It should be good enough that he never
needs a terminal to test a feature.

### 4.3 One command up

`pnpm dev:local` must: start the WSL Postgres cluster if it is down, wait for it,
generate the Prisma client, apply migrations, seed if empty, then run api + web + admin
concurrently and print a table of URLs. One command, cold machine, zero accounts.

Add `pnpm verify` = typecheck + lint + all tests + E2E. That is the gate for §3.6.

### 4.4 Realistic data

The current seed is a catalog. Replace it with **a believable operating season**: a few
hundred orders across past and future dates, mixed statuses, refunds, no-shows,
walk-ups, repeat customers, promo redemptions, and a **second operator** with different
branding so multi-tenancy is visible on screen, not just in a test.

### 4.5 E2E harness

Playwright against the local stack. Phase 0 ships the harness plus the booking funnel
happy path; every later phase adds its own specs.

**Phase 0 acceptance:** on a machine with nothing but this repo, `pnpm dev:local` then
`pnpm verify` goes green, and the owner can book, pay, get a 3DS challenge, read the
confirmation email and SMS in the Local Console, jump the clock to fire a reminder, and
refund it — without an account anywhere.

---

## 5. Phase 1 — Money correctness

Real revenue rides on this, so it comes before features.

- 3DS/SCA challenge handled properly (today anything not `succeeded` is a decline).
- Declines with a clean retry — never a half-created order.
- **Idempotency keys** so a double-submit or a flaky connection cannot double-charge.
- Deposits, partial payments, balance due.
- Refunds, partial refunds, chargeback handling.
- Tax calculation and a remittance report.
- Reconciliation: what we think we collected vs what the processor says.

**Acceptance:** an E2E spec drives every outcome the simulator can produce, including
double-submit, and the ledger balances in each case.

---

## 6. Phase 2 — The customer experience that wins the deal

- **Sub-30-second booking on a throttled mobile connection**, measured by an automated
  test with network throttling, not by feel.
- Guest checkout, no forced account. Wallet buttons (simulated locally).
- **Availability that never lies** — surface true remaining capacity from the shared-
  resource engine instead of optimistic slots.
- "Book that again" for repeat customers; group and split bookings.
- Lighthouse budget enforced in CI: performance 95+, accessibility 100.
- **The embeddable widget** — a script tag an operator drops on their own site that
  opens the full flow in an overlay. Table stakes against FareHarbor.

---

## 7. Phase 3 — Operator depth (parity plus the moats)

- Gift cards: issue, balance, redeem at checkout and in POS.
- Memberships, packages, punch cards, season passes — big for marinas.
- Guide and staff scheduling: assignment, availability, manifest display.
- Multi-location roll-up dashboard and reporting.
- Dynamic pricing: seasonal, weekend, demand, guide markup.
- Upsells and add-ons at checkout.
- Manifest Gantt drag-to-reschedule (list reschedule already works).
- Kiosk mode for the dock.

---

## 8. Phase 4 — Distribution and back office

- Channel/OTA abstraction with a **local mock channel** so it is testable: inventory
  push, booking pull, commission tracking.
- Accounting export: QuickBooks/Xero mapping that actually reconciles a day.
- Operator-editable email and SMS templates.
- A customer-facing booking API for partners.

---

## 9. Phase 5 — Trust and operations

- Backup and **restore drill** run locally, documented.
- Audit log for anything touching money or personal data.
- Rate limits and CORS verified under test (already hardened — prove it).
- Accessibility AA across both apps.
- Data-deletion and privacy requests. The `/terms` and `/privacy` pages exist but still
  need a real legal review — flag that to the owner, and never imply drafted legal text
  has been reviewed.
- Health endpoints, structured logs, and a local load test.

---

## 10. Phase 6 — Cutover

The payoff for §0. Produce a single table: every local driver, its cloud twin, the exact
env vars to swap, and a smoke test that proves the swap worked. Going live becomes
configuration, not a rewrite. Nothing in phases 1–5 may be built in a way that makes
this table impossible to write.

---

## 11. Working rules

- **Verify, then claim.** Run the command, read the output, quote it. See §3.
- **Small commits, conventional messages**, ending with the `Co-Authored-By` trailer.
  Do not push without asking — pushes are cancelled by the Ignored Build Step anyway.
- **Update the docs you invalidate.** `ROADMAP.md` status, `DECISIONS.md` for anything
  architectural (next id is D-016), and this file's phase checkboxes.
- **Ask only when it changes the work.** Routine judgment calls are yours to make. A
  blocking question is for when proceeding either way would waste real effort.
- **Reporting style:** short, plain language, no jargon. Lead with what works now and
  what he can go click. End with a TL;DR.
- **When something is genuinely blocked on the owner** (a real account, a legal review,
  a business decision), say so plainly and keep building everything else.

---

## 12. Phase status

- [~] Phase 0 — Local Sandbox — **mostly done (2026-08-26).**
      Done: `pnpm dev:local` one-command up; a believable season of seed data
      (108 customers, 281 orders); the email + SMS sink and the `/dev` Local
      Console inbox; `pnpm verify`. Still open: the scriptable payment
      simulator with forceable outcomes, webhook replay, the clock control,
      the reset button, storage/auth/errors drivers, and Playwright.
- [ ] Phase 1 — Money correctness
- [ ] Phase 2 — Customer experience
- [ ] Phase 3 — Operator depth
- [ ] Phase 4 — Distribution and back office
- [ ] Phase 5 — Trust and operations
- [ ] Phase 6 — Cutover readiness
