# Performance — the throttled mobile funnel

> "Booking has to take seconds on bad rural cell service. That is our sharpest
> differentiator, because both incumbents' flows are dated and heavy."
> — `docs/LOCAL-FIRST-BUILD.md` §2

§6 turns that sentence into a number: **a first-time guest books in under 30 seconds on a
throttled mobile connection, measured by an automated test, not by feel.** The test is
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

### 2.3 A tap that lands before hydration was thrown away

On a throttled connection the widget is painted and looks live for seconds before its
JavaScript executes. A tap in that window is dispatched to nothing and lost: the guest
watches a rate card refuse to select and taps again. React 18 replays events that arrive
*during* hydration, but not ones that arrive before its runtime has run at all.

The activity page now carries a ~20-line inline script that remembers the tap and
re-applies it once something is listening. Scoped hard, because a blind replay of
arbitrary clicks would be a menace — a late "Continue to checkout" is a navigation nobody
asked for:

- only `role="radio"` controls, whose activation is idempotent and which carry an
  unambiguous success signal in `aria-checked`;
- it stops the instant `aria-checked` flips, so a hydrated app is never clicked twice
  (verified: two rate taps leave exactly one card selected);
- any later real tap supersedes the queued one;
- it gives up 4 s after the document finishes loading, and 15 s after the tap regardless.

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

**The `mobile-throttled` project cannot pass while it points at `next dev`, and no change
to the application can make it pass.** This is arithmetic, not opinion:

| | `next dev` | `next start` (production) |
|---|---|---|
| `Cache-Control` on `_next/static` | `no-store, must-revalidate` | `public, max-age=31536000, immutable` |
| Transferred per navigation | **1 951 kB** | ~0 kB after the warm pass |
| Time to transfer at 400 kbps | **38.1 s** | — |
| Rate cards painted | 2.2 s | **0.67 s** |
| First tap honoured (hydrated) | **never within 60 s** (~41 s) | **1.31 s** |

Slow 4G is 51.2 kB/s. 1 951 kB / 51.2 kB/s = 38.1 s of pure wire time before parsing
starts — the whole 30 s budget spent, twice over, on a bundle the guest would never
download. `warmRoutes` cannot help: `no-store` means the warm pass leaves nothing in the
browser cache to reuse.

What that 1 951 kB is:

| kB | Chunk |
|---|---|
| 1 322 | `main-app.js` — Next/React dev runtime, unminified. Not product code. |
| 509 | the route's own client tree (see §4) |
| 51 | `not-found.js`, shipped on every activity page load in dev |
| 33 | `app-pages-internals.js` |
| 11 | `layout.css` |
| 7 | the HTML document |
| 2 | `GET /api/availability/range` — the funnel's only data request on load |

**The fix belongs in the harness, not the app:** the `mobile-throttled` project needs to
run against a production build (`next build && next start`, or `E2E_WEB_URL` pointing at
one) so the number describes the product. Until that happens the spec is honestly red, and
the 7.3 s in §1 is the closest measurement of the real thing — same throttle profile, same
viewport, same journey, with `_next/static` given production cache headers.

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
  real state on rural cell, and it lasts seconds.
- Lighthouse mobile performance 95+ and accessibility 100 (§6) are **not yet enforced in
  CI**. That gate is still open and depends on §3 as well — there is no point Lighthouse-ing
  a dev server.
