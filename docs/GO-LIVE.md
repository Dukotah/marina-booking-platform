# Go-Live Checklist — from code-complete to first paying tenant

The MVP is built and (mostly) live-verified against Neon. What stands between here and
selling is **wiring external accounts + one end-to-end proof**, not writing features.
Do these stages in order. Each env var below says which app consumes it and where the
value comes from.

Env files live at the repo root (`.env`, gitignored). Copy from `.env.example`.

---

## Stage 0 — Prove the whole flow locally with ZERO external accounts (do this first)

You already have `DATABASE_URL` (Neon) wired and the LSRA tenant seeded. You can drive
the entire booking funnel today, no Stripe/Clerk/Resend needed, using the dev toggles.

Set in `.env`:

```
REQUIRE_CLERK_AUTH="false"          # admin uses the dev OWNER fallback
DEV_FAKE_PAYMENTS="true"            # api: simulate charge/refund, no Stripe
NEXT_PUBLIC_DEV_FAKE_PAYMENTS="true"  # web: simulate the card step in checkout
# leave RESEND_API_KEY empty       → emails no-op but orders still stamp REMINDER_SENT
```

Run the stack (`pnpm dev`) and do the **one test that proves the MVP**:

1. Customer portal (:3000) → open an activity → pick a date → pick a time slot →
   choose a rate → checkout → complete the (simulated) payment.
2. Confirm you land on the confirmation page with an order number.
3. Admin (:3002) → **Manifest** → switch to the List view → the booking appears in
   time order → one-tap **check-in**, then **no-show**, then **undo**.
4. Admin → **Orders** → open the order → **cancel** → verify the timeslot capacity
   is restored (rebook the same slot to confirm).

If all four pass, the product works end-to-end. Everything after this is swapping the
simulations for real services.

---

## Stage 1 — Plug in real services (owner-only accounts)

### 1a. Stripe (test mode first) — payments
- Create a Stripe account → **Developers → API keys** (test mode).
- Get the **webhook signing secret**: Developers → Webhooks → add endpoint
  `https://<api-host>/webhooks/stripe` (for local testing use the Stripe CLI:
  `stripe listen --forward-to localhost:3001/webhooks/stripe` → it prints `whsec_…`).

```
STRIPE_SECRET_KEY="sk_test_…"                    # → apps/api
STRIPE_WEBHOOK_SECRET="whsec_…"                  # → apps/api
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_test_…"   # → apps/web (browser, safe to expose)
```

Then turn OFF the fakes so real Stripe is exercised:
```
DEV_FAKE_PAYMENTS="false"
NEXT_PUBLIC_DEV_FAKE_PAYMENTS="false"
```

### 1b. Resend — confirmation + reminder email
- Create a Resend account → API Keys → create key. Verify a sending domain (or use
  their onboarding sandbox sender for testing).
```
RESEND_API_KEY="re_…"                            # → apps/api (notifications service)
```

### 1c. Clerk — staff/operator auth (keep OFF until last)
- Create a Clerk app → **API keys**. In the Clerk dashboard set the sign-in/sign-up
  paths to `/sign-in` and `/sign-up`, and create your first staff user.
```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_…"         # → apps/admin
CLERK_SECRET_KEY="sk_…"                          # → apps/admin + apps/api
# leave REQUIRE_CLERK_AUTH="false" for now — flip it in Stage 3
```

---

## Stage 2 — The minimal end-to-end proof with real keys

Repeat the Stage-0 booking test, but now verifying the real integrations:

1. **Pay** with Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC.
   → Order completes; in the Stripe dashboard (test mode) a PaymentIntent shows
   `succeeded`.
2. **Webhook** fires → the order's payment is marked paid via `/webhooks/stripe`
   (check the api logs / the order's payment status flips without a manual refresh).
3. **Confirmation email** arrives (check the Resend dashboard "Emails" log).
4. **Refund**: admin → order → refund (full, then try partial) → Stripe shows the
   refund; the order reflects it.
5. **Reminder cron**: `curl -X POST localhost:3001/internal/reminders/run -H
   "x-cron-secret: $CRON_SECRET"` → a booking starting within the window gets a
   reminder email once (a second call is a no-op — REMINDER_SENT dedup).

Set `CRON_SECRET` to any random string for this test; in production the deploy
scheduler sends it as the header.

---

## Stage 3 — Lock the doors

Only after Stage 2 passes:
```
REQUIRE_CLERK_AUTH="true"
```
Now the admin app requires real Clerk sign-in and the API rejects requests without a
valid Clerk bearer token (the `x-dev-staff-id` shim stops working). Sign in as the
staff user you created and re-walk the manifest/orders screens to confirm nothing
locked you out.

---

## Stage 4 — Deploy (the one known blocker)

- **apps/web** — already deploys on Vercel.
- **apps/admin** — last Vercel deploy failed; local `next build` is green. Needs the
  Vercel build log to pin the cause (likely env var missing on Vercel, or the Prisma
  `rhel-openssl-3.0.x` engine / transpile packaging — see the 2026-06-04 changelog
  entry). Fix: ensure all Stage-1 env vars are set in the Vercel project settings for
  BOTH apps, and that admin's build runs `prisma generate` (it does via vercel.json).
- **apps/api** — deploy to Railway (or similar) with all server env vars; set
  `ALLOWED_ORIGINS` to the deployed web + admin origins (comma-separated, https).
- Wire the reminder cron: a scheduled `POST /internal/reminders/run` with the
  `x-cron-secret: $CRON_SECRET` header (Vercel Cron, Railway cron, or GitHub Action).

---

## Go/no-go before charging a real customer
- [ ] Stage 2 passed end-to-end in Stripe **test** mode
- [ ] Swap Stripe test keys → live keys; re-run one real $1-ish booking, then refund it
- [ ] Waiver capture + audit trail reviewed (legal) — already live-verified technically
- [ ] Both apps deployed, all routes reachable, custom subdomain white-label verified
- [ ] Backups on (Neon PITR) + error monitoring (Sentry or similar)
