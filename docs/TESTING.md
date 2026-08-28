# Testing

Three layers, and they are not interchangeable.

| Layer | Where | Runs with | What it proves |
|---|---|---|---|
| **Unit** | `packages/*/src/**/*.test.ts` | `pnpm test` (vitest) | Pricing, money, schedule maths — pure logic, no database |
| **Integration** | `apps/api/src/**/*.test.ts` | `pnpm test` (vitest, live Postgres) | The data path and tenant isolation |
| **End-to-end** | `e2e/specs/*.spec.ts` | `npx playwright test` | Everything a human touches, in a real browser, against the real local stack |

The Definition of Done (`docs/LOCAL-FIRST-BUILD.md` §3.2) requires **all three** for any
feature a person interacts with. A green unit suite over a broken checkout button is the
exact failure this repo is set up to prevent.

---

## What the E2E suite actually drives

No mocks, no fixtures, no test doubles in the browser. Every spec runs against the
running local stack — customer site on `:3000`, API on `:3001`, admin on `:3002` — with
a real Postgres behind it. Payments, email and SMS go through their **local drivers**,
which is the whole point of §0 of the contract: the product is exercised end to end with
no account anywhere.

| Spec | Covers |
|---|---|
| `booking-funnel.spec.ts` | Browse → activity → availability → slot → checkout with waiver → promo → pay → confirmation. Plus: the on-screen total equals the recorded order, and a stale slot fails safely. |
| `payments.spec.ts` | Every outcome the simulator can produce: 3DS challenge, decline (clean retry, **no half-created order**), retry-after-decline, network timeout, and two double-submit paths. |
| `self-service.spec.ts` | Guest looks a booking up, reschedules it, and the vacated slot returns to inventory. Plus: a wrong email reveals nothing. Books only into slots it reserved for itself — see "What a spec guarantees about its own data". |
| `operator.spec.ts` | A booking appears in orders, calendar, manifest and revenue; staff check it in; staff refund it in full and in part. |
| `local-console.spec.ts` | The confirmation **email and SMS actually arrive** in the sandbox inbox and render; the staff alert goes to staff; nothing threw; the payment control arms and disarms. |
| `mobile.funnel.spec.ts` | The funnel on a Pixel 7 over throttled Slow 4G with a 4× CPU slowdown, against a **time budget**. Plus: no horizontal scroll, 44px tap targets. |

---

## One-time install

Playwright is not in `package.json` yet. Add it and the scripts:

```jsonc
// package.json
"devDependencies": {
  "@playwright/test": "^1.49.0"
},
"scripts": {
  "e2e": "playwright test",
  "e2e:ui": "playwright test --ui",
  "e2e:install": "playwright install chromium"
}
```

Then, with pnpm on PATH (it is not by default on this machine — see
`docs/LOCAL-FIRST-BUILD.md` §1):

```powershell
$env:PATH = "C:\Program Files\nodejs\node_modules\corepack\shims;$env:PATH"
pnpm install
pnpm e2e:install     # downloads the Chromium build Playwright drives (~130 MB, once)
```

`playwright install chromium` is all that is needed — every project in the config runs on
Chromium, because the network throttling goes through the DevTools protocol.

---

## Running it

The suite expects the stack to already be up. In one terminal:

```powershell
pnpm dev:local
```

In another:

```powershell
pnpm e2e                                    # everything
pnpm e2e -- --project=desktop               # skip the slow throttled mobile run
pnpm e2e -- e2e/specs/payments.spec.ts      # one file
pnpm e2e -- -g "decline"                    # one test by name
pnpm e2e:ui                                 # pick and re-run tests interactively
```

If a server is down, or the tenant is unseeded, or the Local Console is gated off, the
run stops in `e2e/global-setup.ts` with one sentence telling you which and what to do —
not twenty identical timeouts.

### Letting Playwright start the servers

For CI, or a machine where nothing is running:

```powershell
$env:E2E_START_SERVERS = "1"
pnpm e2e
```

This runs `pnpm dev:local` itself and waits up to five minutes for the stack. On a
machine where pnpm is not on PATH, supply a launcher instead:

```powershell
$env:E2E_SERVER_COMMAND = 'powershell -NoProfile -File scripts/dev-local.ps1'
```

Be aware `dev:local` will seed an empty database. It will not wipe a seeded one.

---

## Debugging a failure

Work down this list; it is roughly cheapest-first.

**1. Read the report.** Every failure keeps a trace, a screenshot and a video.

```powershell
npx playwright show-report e2e/.artifacts/report
```

**2. Open the trace.** This is the one that usually ends the investigation — it is a
frame-by-frame recording with the DOM, the network log and the console at every step.

```powershell
npx playwright show-trace e2e/.artifacts/results/<test-folder>/trace.zip
```

**3. Watch it happen.**

```powershell
pnpm e2e -- --headed --project=desktop -g "reschedules"
pnpm e2e -- --debug -g "reschedules"        # step through with the inspector
```

**4. Slow it down** when something is timing-dependent:

```powershell
pnpm e2e -- --headed --project=desktop --workers=1 -g "double submit"
```

**5. Check the Local Console.** For anything payment- or notification-shaped, open
<http://localhost:3002/dev> and look at the Payments, Inbox and **Errors** tabs. A spec
that fails with "no message yet" is very often a stack trace sitting in Errors.

**6. Reseed** if a spec reports that it cannot find an open slot:

```powershell
pnpm db:reset
```

### Finding a selector

`npx playwright codegen http://localhost:3000` opens a browser that writes locators as
you click. Prefer what it gives you in role/label form and paste it into a page object in
`e2e/helpers/`, not directly into a spec.

---

## Environment knobs

All optional; the defaults match `pnpm dev:local`.

| Variable | Default | Why you'd change it |
|---|---|---|
| `E2E_WEB_URL` | `http://localhost:3000` | Non-default ports |
| `E2E_API_URL` | `http://localhost:3001` | " |
| `E2E_ADMIN_URL` | `http://localhost:3002` | " |
| `E2E_OPERATOR_SLUG` | `lake-sonoma` | Testing a second tenant |
| `E2E_STAFF_ID` | `dev-owner` | A different seeded staff member |
| `E2E_TIMEZONE` | `America/Los_Angeles` | **Must match the operator's timezone** — preflight enforces this |
| `E2E_FUNNEL_BUDGET_MS` | `30000` | Loosen the mobile budget while investigating a regression |
| `E2E_WORKERS` | `2` | `1` to serialise; higher risks the API's 30-req/min public rate limit |
| `E2E_START_SERVERS` | unset | Let Playwright bring the stack up |
| `E2E_SERVER_COMMAND` | `pnpm dev:local` | A launcher that puts pnpm on PATH |

---

## How the suite stays honest

These are deliberate choices, not incidental style. Change them knowingly.

**Test data is derived, never assumed.** No spec knows an order number, a promo code or
a timeslot id. `e2e/fixtures/booking-data.ts` reads the live catalog, scans forward for a
slot that genuinely has room, mints a guest whose email is unique to this run, and
creates its own promo code (deactivating it afterwards). A reseed cannot break the suite,
and two runs cannot collide on a customer record.

**Every spec gives back the capacity it took.** The `seed` fixture cancels each booking
it created when the test ends (`POST /api/orders/:id/cancel`), which restores the
timeslot's seats and releases any shared resource the item held. Without it the suite
spends a little of the tenant's inventory on every run, and "passes on a fresh seed,
fails on the fourth run" is not a test, it is a countdown.

**Only one spec walks the whole funnel.** `booking-funnel.spec.ts` clicks through
browse → activity → slot → checkout. Everything else deep-links to the page it is
actually about, so a calendar-widget regression fails one test instead of twenty. The
deep link is not a shortcut past any check — `/checkout` re-validates every parameter
against live availability.

**Selectors are roles and labels, not classes.** The Tailwind class strings in this app
are regenerated whenever the design moves; `.rounded-2xl` is a test that breaks for no
reason. `getByRole('radio', { name: /9:30 AM/ })` breaks only when the control a guest
touches breaks. There is exactly one class-based selector in the suite, in
`openSms()` — flagged below.

**Waits are on state, never on time.** No `waitForTimeout` anywhere. Where something is
genuinely asynchronous — booking notifications are dispatched fire-and-forget, so a
message lands after the confirmation renders — the suite reloads the server-rendered
console and re-checks, which is what the owner does when he refreshes the tab.

**The browser timezone is pinned.** The fixtures compute a calendar day in the operator's
timezone and then look for that day's label in the browser. If the two disagree the date
selector misses by a day, for part of each day, on some days only. Preflight asserts they
match.

**Performance is measured, and the method is stated.** The mobile spec warms its routes
*unthrottled* first, because `next dev` compiles a route on first request and that says
nothing about how fast the page is for a guest. Only then does it throttle and start the
clock, from the activity page to the confirmation. The measured time is attached to the
test result, not just compared to a threshold.

**No spec calls Reset.** The Local Console's Reset button would wipe the database
another developer — or another test — is using.

---

## What a spec guarantees about its own data

A suite people re-run instead of believe is worth less than no suite. Everything below
was a real intermittent failure in `self-service.spec.ts`, found by running one file
eight times in a row rather than once. **If you are writing a new spec, these are the
rules — a spec that breaks one of them is flaky and does not know it yet.**

### 1. Own your inventory, or you are sharing it with every other spec

`seed.selection()` finds the first slot on the tenant that has room. That is right for a
spec whose subject IS "can a guest find something to book", and wrong for everything
else: the slot it returns depends on what the rest of the suite has already booked
today, so the spec quietly tests different data on every run and eventually finds
nothing at all ("No bookable slot in the next 14 days… reseed with `pnpm db:reset`").

Use **`seed.slot()`** instead. It reserves a timeslot the test owns — created through the
staff `POST /api/availability/generate` endpoint if it does not exist, reused if a
previous run left it empty — and refuses to hand back a slot unless all three of these
hold:

| Check | Why |
|---|---|
| `capacityBooked === 0` | Nothing else is in it, so the numbers are the test's own. |
| `limitedBy === null` | A **shared resource pool** (D-014) is not the binding constraint. Availability publishes the MIN of a slot's capacity and what the pools can honour, so on a pool-limited slot the published figure moves when a boat moves, not when this slot's seats move. |
| `capacityRemaining === capacityTotal` | The pool has headroom for the whole slot, not just for one seat. |

It also places the slot at an hour the seed never uses (the seed opens 8/10/12/14/16),
which keeps `getByRole('radio', { name: /^11:00 PM/ })` naming exactly one control.

### 2. Pin the calendar, do not search it

"The first slot at least 72 hours out" is a different slot at 9am than at 11pm, and near
the boundary it is a slot that only just qualifies. `seed.slot({ daysAhead: 5 })` picks
the same day whatever the clock says, and day+5 is never less than ~92 hours out — well
clear of the 48-hour self-reschedule window and well inside the reschedule dialog's
14-day day strip.

### 3. Know which direction a reschedule moves in

A slot's published capacity is measured over a window that starts at the slot and runs
for the activity's **longest** rate — up to 24 hours for a boat. Move a booking to a
later slot on the same day and it is still inside the old slot's window, so the seats it
vacated do not reappear in the published number: "the freed slot goes back into
inventory" fails while the product is behaving perfectly. A spec asserting on released
capacity must land the move so that it **ends no later than the old slot begins**, and
should assert that precondition rather than assume it.

### 4. Leave the payment simulator as you found it

The outcome queue is per-**operator** global state: whoever charges next pops it. That is
why the suite runs `workers: 1`. It is also why a spec that queues an outcome must
consume it or clear it — `payments.spec.ts` clears in `afterEach`, and
`self-service.spec.ts` checks the queue in `beforeEach` and reports anything it had to
clear. `seed.booking()` fails loudly, naming the queue, if a booking it thinks it paid
for still has a balance.

### 5. The harness is a client, and clients have addresses

Public endpoints are rate-limited at 30/min per `client IP + tenant + route`. Nothing on
a local machine sets `x-forwarded-for`, so without help every request — the fixtures'
and both Next servers' — falls into one `unknown` bucket sharing one budget, and the
fixtures spend the budget the browser needs. `e2e/fixtures/api.ts` gives each test's API
client its own address. It still honours a 429 with the `Retry-After` the API hands
back, on writes as well as reads: the limiter is a real protection and the suite does not
ask for it to be relaxed.

### 6. Say what the page showed, not that a locator timed out

`/account/bookings` renders one screen — "Booking unavailable / We could not find a
booking matching that link" — for a missing order, a wrong email, a 429 and an
unreachable API alike. A spec that only waits for the reservation heading reports every
one of those as a timeout on a heading, which sends the next reader into the reschedule
dialog looking for a fault two layers below it. `e2e/helpers/customer.ts` waits for
either outcome and quotes the refusal.

---

## Known gaps

Stated plainly rather than left to be discovered.

- **`e2e/` is not in `pnpm verify`.** `verify` runs `turbo run typecheck test build`
  across the workspace, and `e2e/` is not a workspace package, so nothing typechecks it
  and nothing runs it. Contract §4.3 wants `verify` to include E2E. That needs a
  `package.json` change (an `e2e` script and `"verify": "... && pnpm e2e"`), which the
  E2E work deliberately did not make.
- **`openSms()` matches a Tailwind class.** The email preview is identifiable by its
  iframe title; the SMS bubble in `apps/admin/components/dev/MessageInbox.tsx` carries no
  role, label or title of its own, and matching it by text would defeat the assertion
  (the list row already contains the same text). A `data-testid="sms-preview"` on that
  element would let the last class-based selector go.
- **The 3DS spec targets behaviour that does not exist yet.** It queues a challenge and
  then expects the checkout to offer the guest a way to authenticate. Today
  `apps/web/app/checkout/actions.ts` treats anything that is not a clean success as a
  failure — which is the exact bug `docs/LOCAL-FIRST-BUILD.md` §5 opens with. The spec is
  the contract for that work, and it fails until the work lands.
- **The idempotency specs likewise.** They send `idempotencyKey` on `POST /api/orders`;
  the field is not in `bookingInputSchema` yet, though `Order.idempotency_key` now exists
  in the schema. Same story: the test states the contract.
- **Lighthouse budgets are not here.** Contract §6 asks for performance 95+ and
  accessibility 100 in CI. This suite enforces a wall-clock funnel budget and a couple of
  mobile-layout invariants, which is not the same thing.

## Run the performance specs against a PRODUCTION build

`mobile.funnel.spec.ts` asserts a real time budget, so it must measure what a guest
actually gets. Against `next dev` it fails — not because the product is slow, but
because the dev server ships unminified code plus the HMR runtime, and hydration under
4x CPU throttling takes seconds longer than it ever would in production. The same spec
that times out in dev passes in about 10 seconds against a production build.

```
pnpm build
# API (its compiled dist cannot resolve the workspace packages yet, so run the source)
cd apps/api  && SANDBOX=local pnpm exec tsx src/index.ts
cd apps/web  && SANDBOX=local pnpm start
cd apps/admin && SANDBOX=local pnpm start
pnpm exec playwright test
```

`SANDBOX=local` is required because the Local Console is hard-gated off when
NODE_ENV=production — that gate is deliberate, and the preflight check will tell you
so. Everything else can be run against `pnpm dev:local` as usual.

---

## Proving a spec is not flaky

One green run proves nothing about a race. Run the file back to back and count:

```powershell
$env:SANDBOX='local'
1..10 | ForEach-Object { pnpm exec playwright test e2e/specs/<file>.spec.ts --reporter=line }
```

`self-service.spec.ts` was 3/8 before the fixes in "What a spec guarantees about its own
data" and is 16/20 after, with **every** remaining failure the one cause below.

### The order-lookup budget is shared by every guest (real defect, not a test problem)

`GET /api/orders/:orderNumber` is rate-limited to 30/min per `client IP + tenant +
route`. The customer portal calls it **server-side** (`apps/web/lib/orders.ts` →
`request()` in `apps/web/lib/api.ts`), and that call carries no `x-forwarded-for`, so
every guest of an operator is one client sharing one 30-per-minute budget for looking up
a booking. Over budget, `apps/web/app/account/bookings/page.tsx` turns the 429 into
`NotAuthorized` — the guest is told **"We could not find a booking matching that
link"** about a booking that exists and is theirs.

Demonstrated directly (a fresh window renders the reservation; an exhausted one does
not):

```powershell
curl "http://localhost:3000/account/bookings?order=LSM-1297&email=…"   # -> Manage this booking
1..32 | % { curl -H "x-operator-slug: lake-sonoma" http://localhost:3001/api/orders/LSM-1297 } | Out-Null
curl "http://localhost:3000/account/bookings?order=LSM-1297&email=…"   # -> Booking unavailable
```

Self-service drives eight of these lookups per run (the two the lookup form costs, plus
one per manage-view render and one per post-reschedule refresh), so back-to-back runs
outrun the budget and a run fails with a booking that "cannot be found". Nothing in
`e2e/` can fix it: the harness cannot set a header on a fetch the Next server makes.

**The fix is in the product, and it is worth making for its own sake** — under any real
concurrency this is guests losing their booking page: forward the guest's address from
the portal's server-side fetch, or let `rateLimit()` recognise a trusted first-party
caller. Until then, a lookup-shaped failure in a tight re-run loop is this, and the
specs now say so in the failure message instead of timing out on a locator.
