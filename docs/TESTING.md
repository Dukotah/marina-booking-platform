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
| `self-service.spec.ts` | Guest looks a booking up, reschedules it, and the vacated slot returns to inventory. Plus: a wrong email reveals nothing. |
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

Known: one or two specs still flake occasionally on timing (a reschedule step has been
seen to fail once and pass on the next run). Treat a single red run as suspect and
re-run before chasing it.
