# Performance — the throttled mobile funnel

> "Booking has to take seconds on bad rural cell service. That is our sharpest
> differentiator, because both incumbents' flows are dated and heavy."
> — `docs/LOCAL-FIRST-BUILD.md` §2

The contract's §6 turns that sentence into a number: **a first-time guest books in under
30 seconds on a throttled mobile connection, measured by an automated test, not by
feel.** (Section numbers in this document refer to this document; references to the
contract say so.) The test is
`e2e/specs/mobile.funnel.spec.ts` running under the `mobile-throttled` Playwright project:
a Pixel 7 viewport with touch emulation, DevTools' Slow 4G profile driven over CDP
(400 ms RTT, 400 kbps each way) and a 4× CPU slowdown, which is roughly a mid-range
Android. Routes are warmed **unthrottled** first, because `next dev` compiles a route on
its first request and that number describes webpack, not the product.

Everything below was measured on the local stack, not estimated.

---

## 1. Where the funnel stands

Full journey — activity page → rate → date → time → checkout → paid confirmation, on
Slow 4G + 4× CPU:

| Step | Cumulative |
|---|---|
| Rate chosen | 1.6 s |
| Date chosen | 2.2 s |
| Time chosen | 3.2 s |
| Checkout open | 4.7 s |
| Guest details + waiver filled | 5.4 s |
| **Confirmation on screen** | **7.3 s** |

**7.3 s against a 30 s budget.** That is with `_next/static` served the way a production
server serves it (`Cache-Control: public, max-age=31536000, immutable`). Read §3 before
quoting this number — under `next dev` the same journey does not finish at all, and the
reason has nothing to do with the booking flow.

> **Provenance.** This table is from the pass that produced it, under production cache
> headers. It has **not** been re-measured since; the numbers re-measured on 2026-08-28
> are the ones in §2.3 and §3, all taken against `next dev`, and they are labelled as
> such. Do not blend the two tables into one figure.

---

## 2. What was actually slow, and what fixed it

### 2.1 The booking route was 1140 px wide on a 412 px phone

The single biggest defect, and it hid in plain sight because a screenshot looks fine when
the *page* is wide — you just never see the right-hand two thirds. Two causes stacked:

- **`body` was a flex column.** A flex item with `margin-inline: auto` is not stretched
  to the container's cross size; auto cross-axis margins suppress `align-self: stretch`
  and the item goes shrink-to-fit. `<main class="mx-auto max-w-6xl">` therefore sized
  itself to its max-content width, clamped only by `max-w-6xl` — 1152 px. Fixed by making
  `body` a plain block box (every route already builds its own full-height column) and
  giving the activity page's `<main>` an explicit `w-full`.
- **A bare `1fr` grid track.** `1fr` is `minmax(auto, 1fr)`, so its floor is the
  *min-content* width of its contents. The booking widget holds a 14-day horizontal date
  strip whose content is ~1056 px wide **by design**, and `overflow-x: auto` does not
  change a box's intrinsic contribution — it makes the box scrollable, not shrinkable. The
  strip's scroll width became the track's floor and the page's width. Fixed with
  `grid-cols-1 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]`, `min-w-0` on every grid
  child, and `min-width: 0` on `.day-strip` itself.

Consequence for the guest: the rate cards sat off-screen, and a tap aimed at one landed
on whatever the browser had scrolled over the top of it. That is what the browser test was
reporting as `locator.click: Timeout 20000ms exceeded — <div role="img"> intercepts
pointer events`, and it is why **`scrollWidth - clientWidth ≤ 1` is now a permanent
assertion** in the mobile spec. Verified 0 px of horizontal overflow at 360, 412 and
1440 px on `/`, `/activities/[id]` and `/checkout`.

### 2.2 The first control was a screen and a half below the fold

Source order on the activity page was gallery → title → description → policy → booking
widget. On a 412 px phone the "Choose a rate" radiogroup started at y ≈ 1283 in a 915 px
viewport: a full-bleed 4:3 hero and a description to scroll past before the guest could
begin.

Source order is now the **mobile** order — title, booking widget, then media and
description — so reading order, tab order and visual order agree with no `order`
juggling, and the desktop two-column arrangement is restored exactly by explicit grid line
placement at `lg` (`lg:col-start-*` / `lg:row-start-*`, with
`lg:grid-rows-[auto_auto_1fr]` so the tall sticky widget does not push the left column's
rows apart). The rate cards now paint at y ≈ 298 — in the first screen.

### 2.3 The rate picker was painted but inert, and queueing the tap did not save it

On a throttled connection the widget is painted and looks live for seconds before its
JavaScript executes. A tap in that window is dispatched to nothing and lost: the guest
watches a rate card refuse to select and taps again. React 18 replays events that arrive
*during* hydration, but not ones that arrive before its runtime has run at all.

**The first attempt queued the tap** and re-applied it once something was listening,
giving up 15 s after the tap and 4 s after `load`. Measured on Slow 4G + 4× CPU against
`next dev`, that is not enough by a wide margin:

| | measured |
|---|---|
| Rate cards painted | 3.3 s |
| Tap dispatched | 3.4 s |
| Queue gave up (tap + 15 s) | 18.4 s |
| React actually listening | **42.3 s** |
| `aria-checked` ever `true` | **never** (still false at 90 s) |

A queue cannot beat a wall 24 s further out than its own deadline, and lengthening the
deadline is worse, not better — a rate that selects itself half a minute after the tap is
a control the guest has already given up on.

**So the group is driven directly instead.** The activity page ships a ~20-line inline
script (`PRE_HYDRATION_RADIOS` in `app/activities/[id]/page.tsx`) that *is* the
radiogroup until React takes over: a delegated `click` sets `aria-checked` on the tapped
control, clears its siblings, and records the choice on the group. The selected look
comes from a matching parse-time stylesheet, so the script writes semantics only.
`BookingWidget` closes the loop — `PreHydrationRadioGroup` opts the group in, reads the
choice back on mount, adopts it into React state, and only then sets `data-hydrated`,
which silences the script for the rest of the page's life.

Result, same profile, same route, same dev server:

| | before | after |
|---|---|---|
| Rate cards painted | 3.3 s | 2.3 s |
| Tap → `aria-checked="true"` | **never** | **26 ms** |
| Selected card survives hydration | n/a | yes (41.1 s, still the tapped one) |

Kept narrow on purpose, because a document-wide click driver is a menace otherwise:

- only inside a group that opted in with `data-prehydration-radiogroup`, and only
  `role="radio"` children of it. Nothing here can fire a navigation or change a party
  size — a late "Continue to checkout" was the real hazard in the queueing design.
- selecting a radio is idempotent and reversible, which is what makes it safe to do
  without the application's agreement.
- it never touches `tabindex` or focus. The controls are real `<button>`s, so Tab and
  Enter/Space already work; a roving tabindex that React would not maintain afterwards
  would leave the group *less* navigable than it is now.

Verified on Slow 4G + 4× CPU, with `data-hydrated` confirmed `false` at the moment of the
tap in every case:

- a tap before hydration selects in 26 ms and is still selected after React mounts;
- two taps before hydration leave exactly one card selected — the second one — and that
  is the one React adopts;
- keyboard works the same way: focus a card, press Enter before hydration, it selects and
  survives;
- after hydration, mouse and keyboard both still select exactly one card, focus stays on
  the radio, and the widget's summary and CTA price update. Checked at 412 px and
  1440 px: no horizontal overflow, desktop two-column layout unchanged.

One expected side effect: because the DOM deliberately diverges from the server HTML,
React logs `Prop 'aria-checked' did not match` in the console when a pre-hydration tap is
adopted. That warning is **dev-only and correct** — React 18 does not overwrite the
attribute, and the mount effect reconciles state a frame later. Do not "fix" it by making
the control inert again.

### 2.4 Comparing two days cost a round trip every time

`TimeSlotPicker` re-fetched a day's slots on every visit. On Slow 4G that is ~400 ms of
latency before a byte of the body moves, paid again each time a guest flicks between
Saturday and Sunday and back. Days are now held in a module-level cache with a **30 s
TTL** and identical in-flight requests share one response; a cached day is seeded during
render, so its chips are in the first frame with no skeleton flash. Measured: three day
taps (A → B → A) now cost 2 requests, not 3.

The TTL is deliberately short. "Availability that never lies" outranks the round trip:
capacity is live inventory and another guest can take the last seat at any moment. It is
not a correctness boundary either way — the booking call re-checks capacity server-side
and rejects a slot that filled, which is the only place that check can be trusted.

Skeleton placeholders were also resized from `h-14` to `h-[52px]` to match a real chip, so
the answer arriving does not shove the guest's thumb target down the page.

### 2.5 The date strip used to be one HTTP request per day

Already fixed in `AvailabilityCalendar` before this pass, recorded here because it is the
largest single win in the funnel: the calendar issued one request per calendar day — up to
31 in parallel for a month — which is 5+ round-trip waves on rural cell before a date can
be picked, and the burst starves the rest of the page. It now uses
`GET /api/availability/range`: **one request covers every day it needs**, results are
cached by day key for the session, and a later month fetches only the days it is missing.

---

## 3. The budget currently measures webpack-dev, not the product

> **Resolved 2026-08-29 — read this section as history, not as current state.** The stack
> the suite runs against is now a production build (`next build` then `next start`), which
> is exactly the fix this section asks for. The 1 943 kB dev bundle below is gone: the
> activity route now transfers **130.2 kB** of JavaScript, and the whole booking funnel is
> re-measured against production in §6. What remains true and worth keeping is the
> reasoning — a budget pointed at a dev server measures webpack, and the arithmetic here
> is why. Note that it is resolved by *how the stack is started*, not yet guaranteed by
> `playwright.config.ts`; a run against `pnpm dev:local` would still measure webpack.

**The `mobile-throttled` project cannot pass while it points at `next dev`, and no change
to the application can make it pass.** This is arithmetic, not opinion:

Re-measured against the live dev server on 2026-08-28, because a number this decisive
should not be taken on trust from a previous pass. It held.

Slow 4G is 51.2 kB/s. Every `_next/static` response carries
`Cache-Control: no-store, must-revalidate`, so `warmRoutes` leaves nothing in the browser
cache and the whole bundle crosses the wire again on the measured navigation:

| kB (gzipped, off the wire) | Chunk |
|---|---|
| 1 321 | `main-app.js` — Next/React dev runtime, unminified. Not product code. |
| 517 | `app/activities/[id]/page.js` — the route's own client tree (see §4) |
| 51 | `not-found.js`, shipped on every activity page load in dev |
| 32 | `app-pages-internals.js` |
| 10 | `webpack.js` |
| 10 | `layout.css` |
| **1 943** | **total → 37.9 s of pure wire time at 51.2 kB/s** |

The whole 30 s budget spent, twice over, on a bundle the guest would never download.
Observed consequence, consistent across five runs: React first executes on this route at
**40.7 – 42.3 s**, and `AvailabilityCalendar`'s one data request (`/api/availability/range`)
does not leave the browser until 42.9 s, because a client component cannot fetch before it
mounts.

**No change to the application can close a 38 s gap that is 68 % Next's own dev runtime.**
Even deleting the route's entire client tree leaves 1 426 kB — 27.9 s — before a byte of
booking logic runs. The fix belongs in the harness: the `mobile-throttled` project needs
to run against a production build (`next build && next start`, or `E2E_WEB_URL` pointing
at one) so the number describes the product. Until that happens the spec is honestly red,
and the 7.3 s in §1 is the closest measurement of the real thing — same throttle profile,
same viewport, same journey, with `_next/static` given production cache headers.

### 3.1 Where the funnel stops today, and what that says

The rate step is no longer where it stops. With §2.3 in place the spec gets through
"choose a rate" in ~2.5 s and fails one step later:

```
Error: expect(locator).toBeEnabled() failed
Locator: getByRole('radiogroup', { name: 'Choose a date', exact: true })
           .getByRole('radio', { name: /^Wednesday, September 9/ })
Received: disabled   ...aria-label="Wednesday, September 9 — checking availability"
```

That is the correct next symptom of the same root cause, in a different component.
`AvailabilityCalendar` renders every day disabled and "checking availability" until its
client-side range request resolves — which cannot begin before hydration, i.e. not before
~41 s here. It is not a defect in the calendar's own logic; it is the dev-bundle wall
again, seen through a control that has a loading state where the rate cards did not.

There is a real product lesson underneath it, worth acting on when §3 is resolved: **the
rate picker needs no data, so it could be made to work with no JavaScript at all, and the
date strip could be too.** The activity page is a server component with API access; if it
server-rendered the 14-day range rollup the way it already server-renders the rate list,
the first two of the guest's three choices would be usable in the first frame on any
connection. That is a change inside `AvailabilityCalendar`'s props and was outside this
pass's ownership.

### 3.2 What was *not* worth doing, and the measurement that says so

Splitting the booking widget's client boundary — lazily loading `AvailabilityCalendar`
and `TimeSlotPicker` out of the route chunk so the rate picker hydrates without waiting
for `date-fns` — was considered and rejected on the numbers:

- it cannot move the wall. `page.js` is 517 kB of 1 943 kB (27 %); the remaining 1 426 kB
  still has to land before React runs at all, and lazy chunks are *additional* requests,
  not smaller ones, so total wire time is unchanged.
- it would make the funnel worse. The calendar chunk would then be requested during
  hydration rather than alongside it, pushing the date strip — already the step that
  fails — later still.
- there is nothing left to win on the control it was meant to help. Rate selection is now
  26 ms from tap, with no JavaScript involved at all.

The lever on `page.js` is §4 (a currency formatter dragging ~700 kB of ledger and
validation code into a customer's browser), not code-splitting the widget.

---

## 4. What is still heavy in the route's own bundle

`app/activities/[id]/page.js` is 2.2 MB unminified in dev. Its largest modules are not the
booking flow:

| kB (dev) | Module |
|---|---|
| 377 | `zod` |
| 462 | `date-fns` (across `format`, `formatters`, `parseISO`, …) |
| 183 | `@marina/core/accounting.ts` |
| 133 | `components/booking/AvailabilityCalendar.tsx` |
| 64 | `@marina/core/money.ts` |
| 45 | `lib/demo/fixtures.ts` |
| 40 | `@marina/core/pricing.ts` |
| 31 | `@noble/hashes` |
| 28 | `@marina/core/reports.ts` |

`zod`, `accounting`, `pricing`, `reports` and `@noble/hashes` are in a *customer's browser*
because `apps/web/lib/format.ts` does `export { formatUSD } from '@marina/core'` — a
barrel re-export — and `@marina/core` only publishes `"."`. One currency formatter drags
in roughly 700 kB of ledger and validation code. `@marina/core`'s barrel is deliberate
(reaching past it is how divergent rounding crept in before), so the fix is to publish a
narrow subpath rather than to bypass it:

```jsonc
// packages/core/package.json
"exports": { ".": "./src/index.ts", "./money": "./src/money.js" }
```

then `export { formatUSD } from '@marina/core/money'` in `apps/web/lib/format.ts`. Single
source of truth preserved, ledger code out of the booking route.

`lib/demo/fixtures.ts` reaching the bundle through `lib/api.ts`'s `DEMO_MODE` branch
deserves the same treatment.

Neither file was in this pass's ownership. Both are worth measuring against a real
production bundle before acting — dev builds do not tree-shake, so the production cost may
be smaller than the table suggests. That measurement is the first thing to do once §3 is
resolved and there is a production build to measure.

---

## 5. Standing rules

- **Never widen the budget to make the number fit.** `E2E_FUNNEL_BUDGET_MS` exists for
  investigation and must not be set in CI.
- **Warm unthrottled, measure throttled.** A performance figure whose method is unclear is
  worth nothing; the spec states its method in its own header for the same reason.
- **A horizontal scroller must never bill its scroll width to the layout.** Every
  `overflow-x: auto` strip needs `min-width: 0`, and every grid track that can contain one
  needs `minmax(0, …)`.
- **Source order is mobile order.** Reordering with CSS `order` splits reading order from
  visual order; explicit grid placement at the desktop breakpoint does not.
- **The first control must be usable, not merely visible.** Painted-but-not-hydrated is a
  real state on rural cell, and it lasts seconds. Make the control work without the
  framework rather than making the guest wait for it — a queue that re-applies the tap
  later is still a control that did not respond (§2.3).
- **One writer per attribute.** A pre-hydration driver and React must never both be
  painting the same group: the driver hands over on `data-hydrated`, and it hands over
  only *after* the component has adopted whatever the guest already chose.
- **Measure transfer size, never file size.** A guest pays for gzipped bytes off the
  wire. `_next/static` compresses to roughly a third, so a budget written against
  `ls -l` is a budget against a number nobody experiences.
- **A number nobody can read is not a measurement.** Every figure this suite produces is
  printed to stdout as well as annotated, so the person who ran it sees what the numbers
  are and not merely that nothing moved.
- **Third-party bytes are a separate budget, and it is zero.** On the local-first stack
  the booking funnel must reach no vendor at all (`docs/LOCAL-FIRST-BUILD.md` §0). See §7.
- The contract's Lighthouse bar (mobile performance 95+, accessibility 100) is now
  enforced by measurement rather than by score: `e2e/specs/performance.spec.ts` for the
  performance half (§6), `e2e/specs/accessibility.spec.ts` at zero serious/critical for
  the accessibility half. Lighthouse itself is not installed and cannot be, so the score
  is not produced; the inputs it scores are.

---

## 6. The enforced budget, and the baseline it was set from

`e2e/specs/performance.spec.ts` is the gate. It replaces "there is one timed test and
nothing watching page weight" with explicit numbers per route, so the next feature that
ships 200 KB of client JavaScript to checkout fails a test instead of quietly costing a
guest on rural LTE thirty seconds.

**Lighthouse is not installed and §0 of the contract forbids installing it.** What
Lighthouse would have measured is available anyway from the DevTools protocol Playwright
already holds open: transfer size per response, largest contentful paint, cumulative
layout shift. The score is not reproduced; the inputs it scores are asserted directly,
which is the half a budget can actually be written against.

### 6.1 Method

Stated plainly, because a performance number whose method is unclear is worth nothing.

- **Against a production build.** `next start` from `next build`, which is what the stack
  now runs. This resolves the blocker §3 was written about.
- **Pixel 7 emulation** (`test.use`), because the guest in the contract is on a phone.
- **Cold cache, every time.** The recorder sends CDP `Network.setCacheDisabled`, so the
  second run of the day measures the same first visit as the first run.
- **Transfer bytes**, from `Network.loadingFinished.encodedDataLength` — gzipped, headers
  included. The same figure as DevTools' "Transferred" column.
- **Counted up to the `load` event only.** Next's router prefetches sibling routes once
  it is idle; billing those to this route would mean adding a link to the catalog could
  fail the checkout budget.
- **First and third party are counted separately**, because they are governed
  differently (§7).
- The throttled measurement warms the route **unthrottled** first, then applies Slow 4G
  (400 ms RTT, 400 kbps) plus 4x CPU through `e2e/helpers/network.ts`. Same profile and
  same helper as `mobile.funnel.spec.ts` — not a fork.

### 6.2 Measured baseline — 2026-08-29, production build

Transfer bytes, gzipped, cold cache, Pixel 7. Byte figures were identical to the decimal
across nine consecutive runs; paint figures are given as the observed range over those
runs, on a laptop that was also running two other agents' builds.

| Route | our JS | CSS | HTML | our total | requests | FCP = LCP | CLS | third party |
|---|---|---|---|---|---|---|---|---|
| `/` catalog | 126.8 KB | 7.8 KB | 9.4 KB | **144.0 KB** | 11 | 108–224 ms | 0.000 | none |
| `/activities/[id]` | 130.2 KB | 7.8 KB | 8.6 KB | **146.6 KB** | 13 | 144–200 ms | 0.000 | none |
| `/checkout` | 168.2 KB | 7.8 KB | 7.4 KB | **183.8 KB** | 16–17 | 88–232 ms | 0.000 | **240–251 KB** (§7) |

Two things worth noticing in that table. FCP and LCP are the same instant on all three
routes — the largest element is in the first paint, which is what server rendering is
for — and CLS is a true zero, because the funnel ships no web fonts, no above-the-fold
images, and skeletons sized to the content they stand in for (§2.4).

Other measurements:

| | measured | budget |
|---|---|---|
| First tap on the rate picker, Slow 4G + 4x CPU | painted 0.6–0.8 s, **selected 0.8–1.1 s** | 3.0 s |
| `apps/web/public/embed.js`, on disk | **45.6 KB** | 50 KB |
| `apps/web/public/embed.js`, on the wire (gzip) | **13.6 KB** | 15 KB |

The ~1 s is the §2.3 design paying off and is worth reading twice: the guest's first tap
takes effect roughly **forty seconds** earlier than React could reach the page on the
profile §3 measured, because the rate group works before hydration. The HTML document is
8.6 KB and carries the rate cards, so at 51.2 kB/s the control is on screen after one
round trip and one small body — the 130 KB of route JavaScript is not on the critical
path to the guest's first choice at all.

The embed loader is checked two ways on purpose. The wire number is what an operator's
visitor waits for; the disk number is what their browser parses on the main thread before
their own page can finish. The spec also asserts that the server actually negotiated
gzip, because a loader served uncompressed costs them 3.4x what we think it does.

### 6.3 The budgets

| Route | our JS | CSS | our total | third party | LCP | CLS |
|---|---|---|---|---|---|---|
| `/` | 145 KB | 12 KB | 165 KB | 0 | 1 000 ms | 0.02 |
| `/activities/[id]` | 150 KB | 12 KB | 168 KB | 0 | 1 000 ms | 0.02 |
| `/checkout` | 195 KB | 12 KB | 210 KB | 0 | 1 000 ms | 0.02 |

Byte budgets are the measurement plus ~15 %: room for a normal feature, not for a
library. The LCP budget is deliberately looser than the measurement warrants — it is
taken on a laptop that is also running Postgres, the API and whatever else is open, and
it wandered 88–232 ms across those runs for reasons that have nothing to do with the
product. It is there to
catch a route that stops rendering its hero on the server, not to police tens of
milliseconds; the measurement with teeth on a bad connection is the 3 s first-interaction
budget. Every budget carries its measured value in a trailing comment in the spec. If you
move one, move the comment and this table in the same edit.

`E2E_TTI_BUDGET_MS` exists for investigation only, on the same terms as
`E2E_FUNNEL_BUDGET_MS` (§5): never set it in CI.

---

## 7. Open finding: checkout downloads 240 KB of Stripe.js it never uses

**This is the one budget that is red, and it should stay red until the code changes.**

Measured on the production build with `SANDBOX=local` and no Stripe key configured:

```
checkout (/checkout) third-party transfer: 240.1 KB against a 0.0 KB budget (+240.1 KB).
    Loaded from https://js.stripe.com:
         240.1 KB  js.stripe.com/v3
```

That is **more than the entire rest of the checkout page** — 240 KB against the 184 KB of
everything we serve — fetched from a vendor CDN on a stack that has no Stripe account,
renders the sandbox card form, and never calls Stripe at all. On Slow 4G those bytes are
about 4.7 seconds of wire time on the most abandonment-sensitive page in the funnel.

**Cause, confirmed in the installed package.** `@stripe/stripe-js@5.10.0`'s main entry
injects the script from module scope, one microtask after import (`dist/index.mjs`, last
lines):

```js
Promise.resolve().then(function () { return getStripePromise(); })
```

`getStripePromise()` appends `<script src="https://js.stripe.com/v3">` to the document.
The fetch is therefore caused by the *import*, not by `loadStripe()`. `PaymentSection.tsx`
guards the call correctly — `stripe.configured && stripe.publishableKey` is false locally
— and it makes no difference, because the module has already queued the download.

**Fix.** Stripe ships a subpath for exactly this, exporting the same `loadStripe` with no
module-scope side effect:

```ts
// apps/web/components/checkout/PaymentSection.tsx
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe } from '@stripe/stripe-js';   // types only; erased at build

// apps/web/components/checkout/walletRequest.ts — the same swap
```

Two files, one import line each. `@stripe/react-stripe-js` does not import
`@stripe/stripe-js` at runtime, so nothing else pulls the eager module back in. A dynamic
`import('@stripe/stripe-js')` inside the `configured` branch would work equally well; the
subpath is smaller and is what Stripe documents.

This is a §0 problem before it is a performance problem: "the owner must be able to
exercise 100% of this product on his own machine without creating an account with
anybody" is not satisfied by a checkout page that cannot finish loading without reaching
js.stripe.com. It is also why the third-party budget is zero rather than "small" — after
the fix this suite, which only ever runs `SANDBOX=local`, should see no vendor request on
the booking path at all. An operator who later configures a real Stripe key in cloud mode
is a different environment and a different measurement.

Neither file is inside the ownership of the pass that found this, so it is recorded here
rather than fixed.

### 7.1 What the production build says about §4

§4 lists roughly 700 KB of ledger and validation code (`zod`,
`@marina/core/accounting`, `@noble/hashes`) reaching the activity route through the
`@marina/core` barrel — measured against a **dev** bundle, which does not tree-shake.
Against the production build the activity route's entire JavaScript is 130.2 KB
transferred, so most of that is already being shaken out, and the narrow-subpath change
§4 proposes is worth far less than its table suggests. It is still the right shape — a
currency formatter should not be able to drag accounting code into a guest's browser —
but it is now a tidiness argument rather than a performance one, and §4's numbers should
not be quoted as if they described what ships.
