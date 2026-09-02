# Go-Live Delta — Replacing Singenuity for Real

The exact ordered steps from "demo-ready local stack" to "taking real customer money
on lakesonoma.com". Do them in order. Flip one thing, verify it, then flip the next.

See `docs/CUTOVER.md` for the full rationale behind each stage and the hard blockers
that nobody can work around by writing code (domain, Stripe business verification,
waiver legal review, etc.).

---

## Stage 1 — Stripe (test mode first)

**Goal:** replace "pay at marina" simulation with a real card charge.

1. Create a Stripe account. Enable test mode.
2. In **Developers → API keys**, copy the test publishable + secret keys.
3. In **Developers → Webhooks**, add endpoint:
   ```
   https://<api-host>/webhooks/stripe
   ```
   For local testing use the Stripe CLI to forward locally:
   ```bash
   stripe listen --forward-to localhost:3001/webhooks/stripe
   # Prints: whsec_…  ← copy this as STRIPE_WEBHOOK_SECRET
   ```
4. Add to `.env` (and to all Vercel/Railway project env vars when deployed):
   ```
   STRIPE_SECRET_KEY="sk_test_…"
   STRIPE_WEBHOOK_SECRET="whsec_…"
   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_test_…"
   ```
5. Switch payment mode off of reserve:
   ```
   # Remove or change these in .env:
   PAYMENT_MODE=""
   NEXT_PUBLIC_PAYMENT_MODE=""
   DEV_FAKE_PAYMENTS="false"
   NEXT_PUBLIC_DEV_FAKE_PAYMENTS="false"
   ```
   `NEXT_PUBLIC_PAYMENT_MODE` and `PAYMENT_MODE` must also be in
   `turbo.json globalPassThroughEnv` — they already are.
6. Verify: book an activity, pay with Stripe test card `4242 4242 4242 4242`, any
   future expiry, any CVC. Order should complete and appear as `succeeded` in the
   Stripe test dashboard.
7. **3DS follow-up (not yet coded):** Cards requiring 3D Secure (e.g.
   `4000 0027 6000 3184`) currently decline rather than redirect to the bank
   challenge screen. A non-`succeeded` PaymentIntent is treated as a decline.
   This must be wired before going live with real keys if the marina expects
   international cards. Track as a code task separate from key wiring.

**Rollback:** set `PAYMENT_MODE=reserve`, `DEV_FAKE_PAYMENTS=true`,
`NEXT_PUBLIC_DEV_FAKE_PAYMENTS=true` — back to "pay at marina" in seconds.

---

## Stage 2 — Resend + sending domain

**Goal:** confirmation emails and reminder emails actually reach customers.

1. Create a Resend account.
2. Add and verify a sending domain (e.g. `mail.lakesonoma.com`) — this requires DNS
   records (SPF / DKIM). Domain propagation is the long pole; start early.
3. Create an API key in the Resend dashboard.
4. Add to `.env` / Vercel:
   ```
   RESEND_API_KEY="re_…"
   RESEND_FROM_EMAIL="reservations@lakesonoma.com"
   ```
5. Verify: make a test booking. The Resend dashboard **Emails** log should show the
   confirmation email delivered within seconds.
6. Verify reminder: call the cron endpoint manually:
   ```bash
   curl -X POST localhost:3001/internal/reminders/run \
     -H "x-cron-secret: $CRON_SECRET"
   ```
   A booking starting within the reminder window should receive one email (a second
   call is a no-op — `REMINDER_SENT` dedup is live).

**Without Resend:** bookings complete normally but customers receive no email.
No-op is the safe fallback — the API never blocks a booking due to a missing email key.

---

## Stage 3 — Clerk staff auth

**Goal:** admin console requires real staff login; the dev OWNER fallback is off.

Do this stage last, after Stripe and Resend are proven in production, because turning
off the fallback locks you out of the admin if anything is misconfigured.

1. Create a Clerk app.
2. In the Clerk dashboard, set sign-in URL to `/sign-in` and sign-up URL to
   `/sign-up`. Set allowed origins to the deployed admin domain.
3. Create your first staff user in Clerk. Note the Clerk user ID.
4. In the marina database, ensure that staff member's row exists with
   `auth_user_id` = the Clerk user ID.
5. Add to `.env` / Vercel (admin app and API):
   ```
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_…"
   CLERK_SECRET_KEY="sk_…"
   NEXT_PUBLIC_CLERK_SIGN_IN_URL="/sign-in"
   NEXT_PUBLIC_CLERK_SIGN_UP_URL="/sign-up"
   ```
6. Flip the master switch:
   ```
   REQUIRE_CLERK_AUTH="true"
   ```
7. Open the admin app. You should be redirected to `/sign-in`. Log in as the staff
   user. Manifest, orders, and dashboard should all work as before.

**Customer magic-link status:** customer auth (`/account` order lookup) currently
uses order-number + email stub. The magic-link / OTP flow (a real token table +
registered email sender) is not yet coded. This is a separate code task, not a key
wiring task. Customer-facing booking is not gated on this — customers can still
complete and retrieve bookings via order number.

**Security note:** with more than one operator in the database, the admin dev-OWNER
fallback hardcodes `lsra` as the operator. A second operator's Clerk user would
receive OWNER access to Lake Sonoma's data if Clerk is enforced before this is fixed.
Fix the staff lookup in `apps/admin/lib/session.ts` before enabling Clerk with more
than one tenant.

**Rollback:** `REQUIRE_CLERK_AUTH="false"` — dev fallback returns immediately.

---

## Stage 4 — Neon (cloud Postgres) + Vercel deploy

**Goal:** the booking stack runs in the cloud, not on the owner's laptop.

1. Create a Neon project. Copy the **Pooled** and **Direct** connection strings.
2. Provision the `app_user` role and apply migrations in Neon:
   ```bash
   export PATH="$HOME/.npm-global/bin:$PATH"
   cd /home/dukotah/marina-demo
   # Set env to Neon values, then:
   pnpm --filter @marina/database migrate:deploy
   pnpm db:rls
   pnpm db:approle   # creates app_user NOBYPASSRLS role
   pnpm db:seed      # loads LSRA operator + activities + timeslots
   ```
3. Add to Vercel project env vars for all three apps (web, admin, API host):
   ```
   DATABASE_URL="postgresql://…?sslmode=require&pgbouncer=true"  # pooled
   DIRECT_URL="postgresql://…?sslmode=require"                    # direct
   APP_DATABASE_URL="postgresql://app_user:…@…?sslmode=require"
   APP_DB_PASSWORD="<app_user password>"
   ```
4. Import the repo into Vercel:
   - **marina-web** → Root Directory: `apps/web` → the customer booking app
   - **marina-admin** → Root Directory: `apps/admin` → the operator console
5. Deploy the API (Hono) to Railway or Render:
   - Install: `pnpm install --frozen-lockfile`
   - Build: `pnpm --filter @marina/database generate && pnpm --filter @marina/api build`
   - Pre-deploy: `pnpm --filter @marina/database migrate:deploy`
   - Start: `node apps/api/dist/index.js`
   - Health check path: `/health`
6. Add `API_URL` (the deployed API base URL) to the Vercel env for both web and admin.
7. Add `ALLOWED_ORIGINS` to the API host (comma-separated: web + admin deployed origins).

---

## Stage 5 — Booking subdomain DNS + LakeSonoma flip

**Goal:** `book.lakesonoma.com` serves the booking app and every "Book Now" CTA on
the marketing site points to it instead of Singenuity.

1. In Vercel, add the custom domain `book.lakesonoma.com` to the marina-web project.
2. Add the CNAME record in the domain registrar's DNS panel as Vercel instructs.
3. Wait for propagation (minutes to hours depending on TTL).
4. In the LakeSonoma repo (Vercel project), set the env var:
   ```
   NEXT_PUBLIC_BOOKING_URL="https://book.lakesonoma.com"
   ```
   This is the single switch. Every "Book Now" CTA on the marketing site
   (`lakesonoma.com`) automatically deep-links to the new booking app instead of
   Singenuity. No code change is required — it is a pure env change.
5. Redeploy the LakeSonoma Vercel project so the new `NEXT_PUBLIC_BOOKING_URL` is
   inlined into the client bundle (Next.js `NEXT_PUBLIC_*` vars are baked in at
   build time, not read at runtime).
6. Verify: open any product page on `lakesonoma.com`, click **Book Now** — browser
   navigates to `book.lakesonoma.com/activities/<slug>`. Activity loads correctly.

**Rollback:** unset `NEXT_PUBLIC_BOOKING_URL` and redeploy LakeSonoma — every CTA
reverts to Singenuity deep links immediately.

---

## Stage 6 — Reminder cron (CRON_SECRET)

**Goal:** customers receive a pre-arrival reminder email automatically.

The reminder endpoint `POST /internal/reminders/run` is already coded and deployed.
It needs a scheduler and a secret.

1. Generate a random secret (e.g. `openssl rand -hex 32`).
2. Add to the API host env:
   ```
   CRON_SECRET="<random 32+ char string>"
   ```
3. Create a scheduled job (Vercel Cron, Railway cron, GitHub Action, or similar) that
   fires hourly and calls:
   ```
   POST https://<api-host>/internal/reminders/run
   Header: x-cron-secret: <CRON_SECRET>
   ```
4. Verify: make a booking starting within the reminder window. Call the endpoint
   manually. Check the Resend log for the reminder email. Call again — should be a
   no-op (no second email sent).

If `CRON_SECRET` is unset, the endpoint is open — anyone can trigger a reminder
sweep. Set it before go-live.

---

## Go / no-go gate before charging a real customer

- [ ] Stage 1 complete: Stripe test card `4242…` creates a `succeeded` PaymentIntent
- [ ] Stage 1 complete: webhook fires and stamps the order paid without a manual refresh
- [ ] Stage 2 complete: confirmation email arrives in Resend logs on a real booking
- [ ] Stage 2 complete: reminder cron fires, deduplicates correctly
- [ ] Stage 3 complete: admin requires Clerk sign-in; staff user can reach Manifest
- [ ] Stage 4 complete: all three deployed apps return 200 on their health/root routes
- [ ] Stage 5 complete: book.lakesonoma.com serves the booking app; LakeSonoma CTAs point to it
- [ ] Stripe test → live key swap: run one $1 real booking and immediately refund it
- [ ] Waiver, Terms, and Privacy reviewed by a lawyer (hard gate — do not skip)
- [ ] Business insurance policy language consistent with waiver text
- [ ] Neon PITR (point-in-time restore) enabled on the production database
- [ ] `CRON_SECRET` set and scheduler active

---

## Known open polish items (P2 — does not block go-live)

These are documented defects from the QA pass. None block the booking flow or
produce incorrect data, but each carries a customer friction or confusion risk.
Fix in priority order after go-live is stable.

### Guest detail form buried below fold on mobile (390px)

In `apps/web/app/checkout/CheckoutClient.tsx`, the grid has two children: the
"Your reservation" summary card at `order-1` (line 661) and the "Guest details"
section at `order-2` (line 604). On viewports narrower than the `lg` breakpoint
(1024px), the `lg:order-*` overrides are inactive, so CSS source order puts the
reservation summary first visually. On a 390 x 844 viewport the first input
(`firstName`) renders at approximately y=1447px — the customer must scroll 1,400px
before seeing the name field. Fix: swap the `order-1`/`order-2` values on mobile so
the form appears first and the summary below it.

### Book CTA slug-to-cuid redirect visible in address bar

`data/booking.ts productBookingUrl()` (line 117) builds deep links as
`${BOOKING_URL}/activities/${activitySlug}`. The booking app resolves both slugs and
cuids server-side correctly, but the browser briefly shows the slug URL before
Next.js client-side navigation rewrites it to the cuid URL. No data loss — cosmetic
only.

### Quest Fishing Pontoon shows duplicate photo (10-Person Pontoon photo reused)

The Quest Fishing Pontoon upload (`2e0fbcfada5e69c7ca7bc6b83648f1b2.jpg`) is
byte-for-byte identical to the 10-Person Pontoon photo. The catalog seed maps
`quest-fishing-pontoon` to source `3633.jpg` (the 10-Person Pontoon source) because
no dedicated Quest photo exists in the LakeSonoma asset library at
`/mnt/c/Users/dukot/projects/LakeSonoma/public/images/singenuity/`. Confirm with
the marina owner whether a dedicated photo exists.

### 11:00 PM timeslot on boat detail pages (base-seed leftover)

Timeslot `cmtfbv7fz009uc1rcopd9rnxn` at `2026-09-04T06:00:00.000Z` UTC = 11 PM PDT
appears on the 5-Person Pontoon detail page alongside the expected 8 AM / 10 AM /
12 PM / 2 PM / 4 PM slots. It is a leftover from the base seed (`seed.ts`), which
used a different UTC offset than the catalog sync script (`SLOT_HOURS [8,10,12,14,16]
+ PT_UTC_OFFSET 7 = [15,17,19,21,23] UTC`). The catalog sync adds missing slots but
never deletes existing ones. Fix: delete base-seed-originated timeslots that fall
outside the catalog SLOT_HOURS windows, or add a cleanup step to the sync script.

### LakeSonoma page titles duplicate the operator name

`/mnt/c/Users/dukot/projects/LakeSonoma/app/layout.tsx` defines title template
`'%s · Lake Sonoma Marina'`. Every inner page passes a title that already contains
`— Lake Sonoma Marina` (e.g. `app/rentals/page.tsx` line 18). Result:
`Boat Rentals — Lake Sonoma Marina · Lake Sonoma Marina`. Fix: remove
`— Lake Sonoma Marina` from each page's `pageMeta()` title argument, letting the
template append it once.

### GET /catalog returns 404 on the customer portal

The dev log shows four confirmed `GET /catalog 404` hits on the booking app during
a QA session. No `/catalog` page route exists in `apps/web/app/`. The hits follow
`GET /` and `GET /terms` navigation, suggesting a prefetch trigger from the
LakeSonoma-to-booking-app transition. Root cause unconfirmed — investigate whether a
Next.js prefetch is treating the marketing site's `/catalog` route as a booking app
route.

### Booking app breadcrumb "Book" returns to booking catalog, not LakeSonoma site

`apps/web/app/activities/[id]/page.tsx` line 198 renders
`<Link href='/'>Book</Link>`. A customer who arrived via deep-link from the marketing
site has no path back. Fix: render the breadcrumb as a link to `NEXT_PUBLIC_BOOKING_URL`
root (the marketing site) when the env var is set, falling back to `/` otherwise.

### Rate tier labels differ between LakeSonoma and booking app

LakeSonoma `data/marina.ts` (lines 85-88) shows tier labels `1 hour / 4 hours /
8 hours / 24 hours`. The booking app database `Rate.name_external` values are
`One Hour / Half Day (4 hr) / Full Day (8 hr) / Overnight (24 hr)`. A customer sees
`4 hours — $350` on the marketing site and must match it to `Half Day (4 hr) — $350`
in the booking app. Most confusing on the 24-hour tier where `Overnight` vs `24 hours`
have different connotations. Fix: align `Rate.name_external` values in the seed to
match the marketing site labels, or update the marketing site labels to match the
booking app.

### LakeSonoma dev server 500 after context restart (stale .next cache)

After an interrupted dev session, `localhost:3005` may return HTTP 500 with
`Cannot find module ./331.js`. Recovery:
```bash
fuser -k 3005/tcp
rm -rf /mnt/c/Users/dukot/projects/LakeSonoma/.next
cd /mnt/c/Users/dukot/projects/LakeSonoma && npx next dev -p 3005
```
Development-only issue; production builds are unaffected.

### Rate selection: One Hour pre-selected but not visually confirmed until full selection

On activity detail pages, `One Hour` is `aria-checked=true` by default. A user who
picks a date and timeslot without explicitly clicking a rate checks out at `One Hour`
($125) even if they intended `Half Day` ($350). No price calculation bug — the button
label is always consistent with the selected rate. Fix: add a visible "Selected: One
Hour" confirmation above the date picker so the current selection is unambiguous.

### Grand Patio intentionally unbookable online

The Grand Patio (slug: `patio-grand`) has `hide_price=true` and no rates. The
catalog page correctly shows "Coming soon" and "Pricing soon." Clicking through opens
the detail page with the copy "Contact the marina for custom and group pricing." Not
a regression — documented for completeness.

### Dormant Singenuity image fallback wired in LakeSonoma source

`lib/singenuity.ts` exports `singenuityImage()` which builds a `res.cloudinary.com/singenuity`
CDN URL. This is used as the fallback in `components/ProductCard.tsx` (line 23) and
`app/product/[slug]/page.tsx` (line 111). Currently all products have local
`/images/products/` photos so the fallback never fires. But a new boat added without
a local photo would silently load from Singenuity's CDN. Fix: replace the
`singenuityImage` fallback with a local placeholder image.

### React hydration mismatch on LakeSonoma footer newsletter form

On cold dev-server boot, the browser console logs a React hydration mismatch on the
newsletter email input and botcheck checkbox (`style={{}}` vs
`style={{caret-color:'transparent'}}`). No visible rendering artifact. Source:
`components/Footer.tsx` (or `components/NewsletterForm.tsx`). Not a production issue
in a static build.

### Quest Fishing Pontoon uses singenuityId: 0 as React key

`singenuityId: 0` is falsy in JavaScript. It is used as the React `key` in
`app/page.tsx`, `app/rentals/page.tsx`, `app/patios/page.tsx`, and
`app/pricing/page.tsx`. No duplicate-key collision currently (no other product has
`singenuityId: 0`), but the pattern is fragile. Fix: use `p.slug` as the React key
everywhere.

### /activities route returns 404

`GET localhost:3000/activities` returns 404 — no `page.tsx` exists at
`apps/web/app/activities/`. The route is intentionally absent by design (the
`EmbedRouterProvider` treats `/activities` as equivalent to `/`). The 404 appeared
once in the browser console during session warm-up from a speculative prefetch.
Harmless in practice.

### Back button from checkout clears all booking selections

Pressing Back from `/checkout` returns to the activity page with rate, date, and
timeslot reset. The customer must re-select from scratch. Fix: persist selections to
`sessionStorage` keyed by `activityId` and restore on mount, or encode
rate/date/timeslot in the URL query string.

### Turbopack HMR cross-contamination in dev (booking app and LakeSonoma open simultaneously)

When both dev servers (:3000 with webpack, :3005 with Turbopack) are open in the same
browser session, Turbopack HMR WebSocket events from :3005 can cause the active :3000
tab to navigate away. Workaround: stop :3005 while testing :3000 pages. Production
builds are unaffected.

### Confirmation page shows total (tax + fee) as balance due, not base rental price

`/confirmation` reads `balanceDueCents` (full total including tax and processing fee)
as the "due when you arrive" amount. For a $125 One Hour rental, the confirmation
reads "Nothing was charged today — $142.02 is due when you arrive." The API correctly
exposes `subtotalCents`, `taxCents`, and `processingFeeCents` separately. Consider
displaying the breakdown (base + tax + fee) so the customer understands what they owe
at the marina.

### Customer-visible developer placeholder in newsletter form footer (LakeSonoma)

`components/NewsletterForm.tsx` (line 77) renders the text "Newsletter activates once
the form key is set." in the page footer when `WEB3FORMS_ENABLED` is false (no
Web3Forms key configured). Fix: hide the form entirely when the key is absent, with
no visible placeholder text.

### Singenuity preconnect hint present in LakeSonoma layout (currently gated)

`app/layout.tsx` line 52 has `<link rel='preconnect' href='https://book.singenuity.com' />`
inside `{!BOOKING_APP_ENABLED && ...}`. With `NEXT_PUBLIC_BOOKING_URL` set, the tag
is NOT rendered — verified. If `NEXT_PUBLIC_BOOKING_URL` is ever unset (e.g. a
rollback), the Singenuity preconnect silently returns. Remove the hint post-switchover.
