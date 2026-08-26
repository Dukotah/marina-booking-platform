# North-Star Roadmap — Beat FareHarbor & Singenuity, Run Our Own Marina

_Owner goal: run Lake Sonoma Marina on this software, and make it clearly 10x better
and easier for the customer than FareHarbor and Singenuity. This doc is the full-
architecture plan so nothing gets missed._

Status date: 2026-07-12.

---

## 0. Honest current state (what "broken buttons" actually was)

The product is **Phase-1 MVP-complete**, not hollow. The dead-links/greyed-calendar you
hit were a **config problem, not a missing product**: the customer app shipped with
`NEXT_PUBLIC_DEMO_MODE` defaulting ON, which serves static fixtures (no real availability)
instead of the seeded database. Fixed 2026-07-12 (demo off for local dogfooding; the
`/lookup` → `/account` links and missing `/terms` + `/privacy` pages fixed too).

**What is already built and works:**
- Full customer funnel: catalog → activity → live availability → checkout (waiver +
  DOB + signature, promo, tip, fake-pay) → confirmation → lookup → self-reschedule.
- Operator admin: dashboard KPIs, orders (+refunds), calendar, **dense manifest with
  one-tap check-in/no-show**, customers CRM, activities, **integrated POS**, reports +
  CSV, staff/RBAC, settings (branding/locations/fees/policies/integrations/resources).
- **Super-admin platform console** (create/edit/impersonate operators).
- **Shared-resource capacity engine** (one boat can't double-book across activities).
- **Automated pre-arrival email reminders** (cron-swept, idempotent).
- Multi-tenant hardness: RLS + composite FKs, 8/8 isolation tests green.
- Stripe charges + full/partial refunds + webhooks; dev fake-payments mode.

**The three moats we already hold vs the incumbents:** unified dashboard + built-in POS
(Singenuity is 3 apps), shared-resource blocking, and automated reminders + dense
manifest. Everything below is about (A) making it truly ours to run, and (B) turning
"parity + 3 moats" into "10x better."

---

## 1. The two tracks

This roadmap runs two tracks in parallel because they answer two different questions.

- **Track A — "Run our marina" (go-live readiness).** Everything required to take a
  real paying booking at Lake Sonoma. Depth features are worthless if we can't safely
  operate. This track is mostly wiring + reliability, not new surface.
- **Track B — "10x better" (competitive depth).** The feature/UX work that makes an
  operator leave FareHarbor/Singenuity and a customer prefer booking with us.

Each item below has an **acceptance test** — the concrete "it works like I expect" proof
so we don't hand-wave "done."

---

## 2. Track A — Go-live readiness (our marina on it)

### A1. Prove the whole thing locally, end to end (this week)
- Run both apps on the real seeded DB (done: demo off).
- Walk one real booking: browse → book → fake-pay → confirm → it appears in admin
  revenue, orders, calendar, manifest; check it in; refund it; reschedule it.
- **Acceptance:** a single booking traced through every screen with zero console errors.

### A2. Wire the four external accounts (no code rework — env only)
Per `docs/GO-LIVE.md`. Each is a swap, gated behind flags already in the code.
1. **Neon Postgres** (prod DB) → `DATABASE_URL`/`DIRECT_URL`/`APP_DATABASE_URL`.
2. **Stripe** test keys → real charges + refunds + webhook secret.
3. **Resend** API key → real confirmation/reminder/refund emails.
4. **Clerk** → staff auth on; then customer magic-link (A4).
- **Acceptance:** one Stripe *test-mode* booking charges a card, emails a real receipt,
  and shows in the Stripe dashboard + our admin.

### A3. Payment correctness for real money (blocking)
- **3DS / SCA challenge flow** (today: anything not `succeeded` = decline). Required for
  real cards, EU guests, and high-value bookings.
- Failed-payment + retry UX; idempotency keys so a double-submit can't double-charge.
- **Acceptance:** Stripe's 3DS test card completes a challenge and books; a forced
  decline shows a clean retry, never a half-created order.

### A4. Customer auth that isn't a stub
- Replace email + order-number lookup with **Clerk magic-link** (passwordless).
- **Acceptance:** a customer gets a login link by email and sees only their bookings.

### A5. Reliability & operations (the unglamorous go-live gates)
- **Reminder cron** actually scheduled (Vercel Cron / GitHub Action hitting
  `/internal/reminders/run`) — not just an endpoint.
- **Logo/image upload** (Cloudflare R2) instead of URL fields.
- **Backups + restore** drill on Neon; **error monitoring** (Sentry) on all three apps.
- Fix the known **admin `next build` /404,/500 static-export quirk** before deploy.
- Rate-limit + CORS already hardened (branch `harden/api-ratelimit-cors`) — verify live.
- **Acceptance:** reminders fire on schedule unattended; an uploaded logo renders; a
  thrown error shows up in Sentry; admin deploys green.

### A6. Deploy
- Web + admin on Vercel, API on Railway (or fold API into web per demo-deploy notes).
- Custom domain mapping for the operator (`book.lakesonomamarina.com`).
- **Acceptance:** the public URL takes a real test booking start to finish.

---

## 3. Track B — 10x better (competitive depth)

Ordered by leverage: complete the moats first, then close the gaps FareHarbor uses to
win, then the upmarket features.

### B1. Finish the moats we already lead on
- **SMS channel (Twilio)** on the existing reminder sweep — booking confirmations +
  pre-arrival reminders by text. This is the single biggest no-show reducer and Singenuity
  doesn't have it. _(Integration table + sweep already built; only the Twilio service +
  admin toggle are missing.)_
- **Resource conflict visible to the customer** — the calendar already *enforces* pool
  limits but still shows optimistic slots; surface true remaining capacity.
- **Manifest Gantt drag-to-reschedule** — the list reschedule works; finish the visual.
- **Acceptance:** a text lands on a real phone for a booking; a fully-booked boat's slot
  greys out for the customer; dragging a booking on the Gantt moves it.

### B2. Close the FareHarbor gaps (why operators pick them)
- **Gift cards** — issue, track balance, redeem at checkout + POS. (PaymentMethod enum
  exists; needs issuance/balance service + UI.)
- **Memberships / packages / punch-cards** — recurring or bundled access with member
  pricing. Big for marinas (season passes, 10-launch cards).
- **Multi-location roll-up** — cross-location KPI dashboard + reporting for chains.
- **Guide/staff scheduling** — assign guides to bookings, show on manifest, block by
  guide availability. (GUIDE role exists; needs assignment UI + availability.)
- **Acceptance:** sell a $500 season pass, redeem it across two bookings; a 2-location
  owner sees combined revenue; a guide is assigned and appears on the day manifest.

### B3. Upmarket / revenue features
- **Dynamic pricing** — seasonal, weekend, demand-based, and guide-markup rules.
- **OTA / affiliate channels** — Viator/GetYourGuide/Airbnb Experiences sync for
  affiliate revenue (this is FareHarbor's real lock-in).
- **Accounting export** — QuickBooks/Xero mapping; tax-remittance report.
- **Upsells & add-ons** at checkout (life-jacket rental, photos, cooler).
- **Acceptance:** a weekend slot prices higher automatically; a QuickBooks export
  reconciles a day's revenue; an add-on lifts average order value.

### B4. The "easier for the customer" bet (our differentiator)
This is where we out-UX both incumbents, whose booking flows are dated.
- **~15-second mobile booking** on weak rural LTE (mirrors the Websites-factory north
  star): minimal steps, big tap targets, remembers the guest.
- **Guest checkout with one-tap Apple/Google Pay**; no forced account.
- **Group / split bookings** and easy "book the same thing again."
- **Live availability that never lies** (B1) so nobody hits "sorry, just sold out."
- **Acceptance:** a first-time mobile user books in under ~30s on a throttled connection;
  Lighthouse mobile ≥ the factory bar (perf 95+, a11y 100).

---

## 4. Full-architecture checklist (so nothing is missed)

Cross-cutting concerns to review before we call it "finished" — each is a real column of
the product, not a feature.

- **Domain model:** gift cards, memberships, packages, dynamic-price rules, guide
  availability, OTA mappings (several are schema-only today).
- **Money:** 3DS/SCA, idempotency, partial/deposit payments, payouts/settlement,
  refunds/chargebacks, tax remittance, reconciliation, currency.
- **Comms:** email (done) + SMS (B1) + receipts + templates the operator can edit.
- **Auth & roles:** customer magic-link (A4), staff RBAC editor UI, guide scoping.
- **Multi-tenant:** custom-domain mapping, per-tenant billing/plan enforcement, isolation
  tests still green after every schema change.
- **Reliability:** backups, monitoring/Sentry, cron scheduling, rate-limits, uptime,
  graceful degradation when Stripe/Resend/Twilio are down.
- **Data & reporting:** revenue/occupancy/tax (done) + multi-location + exports +
  chargeback/reconciliation.
- **Performance/UX:** mobile-first booking speed, Lighthouse budget, accessibility.
- **Compliance:** waivers (done) + real Terms/Privacy (stubs added; owner legal review) +
  PCI scope (Stripe Elements keeps us out of scope) + data-deletion requests.
- **Operability:** onboarding wizard (exists), logo upload, kiosk mode, staff training
  surface, and a "provision a new operator" path (platform console exists).

---

## 5. Suggested sequencing (a few weeks)

- **Week 1 — Track A1–A2 + B1 (SMS):** prove it locally end-to-end, wire the four
  accounts in test mode, land Twilio. Outcome: we can take a real test booking with
  email+SMS.
- **Week 2 — Track A3–A5:** payment correctness (3DS), customer magic-link, reminder
  cron, uploads, monitoring, admin build fix. Outcome: safe to run our marina.
- **Week 3 — Track A6 + B2 start:** deploy to our domain; begin gift cards +
  multi-location roll-up + guide scheduling. Outcome: **live at Lake Sonoma.**
- **Week 4+ — Track B2 finish + B3/B4:** memberships/packages, dynamic pricing,
  upsells, the sub-30s mobile flow, then OTA/accounting for upmarket sales.

Ship in this order and each week ends with something provable, we're never "mostly done,"
and by ~Week 3 the owner is running real bookings on it while the depth features keep
landing.
