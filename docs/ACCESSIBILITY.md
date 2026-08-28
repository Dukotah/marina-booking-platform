# Accessibility — customer booking flow

The customer booking flow and the two operator screens staff live in, against
**WCAG 2.1 Level AA**.

This is not a polish pass. The flow is completed one-handed, on a phone, on rural
cell service, often standing on a dock, and it ends in a **legal signature**. An
initials box a screen reader cannot distinguish from eleven identical initials
boxes is a liability problem, not a styling problem.

The document has two halves. **§1 is the accessibility pass** — what was changed and
why. **§2 and §3 are the audit** — what is now checked automatically on every run, and
what that check currently finds. Read §3 first if you want the honest state: the audit
is red, on purpose, and it names eleven serious/critical violations plus four failures
axe cannot see. "AA" is not claimed here; what is claimed is that the claim is now
measured.

Files changed in the §1 pass:

| File | Role in the flow |
|---|---|
| `apps/web/components/layout/SiteHeader.tsx` | Site chrome on every customer page |
| `apps/web/components/layout/SiteFooter.tsx` | Site chrome on every customer page |
| `apps/web/components/checkout/CheckoutClient.tsx` | Checkout orchestrator + submit |
| `apps/web/components/waiver/WaiverSigner.tsx` | Clause-level waiver signing |
| `apps/web/app/account/lookup-form.tsx` | "Find my booking" lookup |

---

## 1. What was fixed

### 1.1 Landmarks and heading order

| Change | Standard |
|---|---|
| Added a "Skip to main content" link as the first focusable element of every page (visually hidden until focused, targets `#main-content`). | 2.4.1 Bypass Blocks |
| The demo banner was a bare `<div>` above the header — content belonging to no landmark. It is now an `<aside aria-label="Demo mode notice">`. | 1.3.1 Info and Relationships |
| Checkout section cards rendered `<h3>` under the page's `<h1>` (the shared `CardTitle` is an `h3`), skipping a level. Each card is now a `<section aria-labelledby>` with a real `<h2>`. | 1.3.1, 2.4.6 Headings and Labels |
| The waiver title rendered as a plain `<div>` and clause titles as `<h4>` under an `<h1>` — two skipped levels and no document outline. Title is now `<h2>`, clauses `<h3>`. | 1.3.1, 2.4.6 |
| The tip presets are now a `role="group"` labelled by the visible "Add a tip" text, so each toggle carries context when reached out of order. | 1.3.1 |

**The skip link needs one line per page to work** — see finding I in §3.3, where
the audit measures exactly how inert it is today. Until then it is
inert (activating it does nothing); it never breaks anything, but it does not yet
bypass anything either. Bypass Blocks is still satisfied in the meantime by the
landmark structure (ARIA11), which is a sufficient technique on its own.

### 1.2 Labels, descriptions, and error association

| Change | Standard |
|---|---|
| **Waiver initials boxes** were all named just "Initials". Each is now named `"Initials, <clause number and title>"` via `aria-labelledby` pointing at the label *and* the clause heading. A screen-reader user can now tell which legal clause they are initialling. | 4.1.2 Name, Role, Value; 2.4.6 |
| Required initials boxes now carry `aria-required` and a visible required marker; when unmet after a submit attempt they carry `aria-invalid` plus `aria-describedby` pointing at their own error text. This is the "required **and** unmet" announcement. | 3.3.2 Labels or Instructions; 3.3.1 Error Identification |
| The typed signature field now has a bound description explaining that typing the name *is* the signature; the date of birth field explains why it is collected (guardian co-signature). Previously both were unexplained. | 3.3.2 |
| Lookup form: the two hint paragraphs were visually adjacent but programmatically orphaned. Both are now bound with `aria-describedby`, and on a failed lookup the failure message id is prepended to both fields' descriptions and `aria-invalid` is set. | 1.3.1, 3.3.1 |
| Header logo `<img>` had `alt={brand.name}` inside a link already labelled `"<brand> home"`, so the operator name was announced twice. The image is now decorative (`alt=""`). | 1.1.1 Non-text Content |

### 1.3 Errors announced, and focus moved to them

Before this pass, a failed checkout submit was **completely silent** to a screen
reader: react-hook-form marked the fields, the page did not move focus, and the
inline messages were `role="alert"` elements that had already been in the DOM.

| Change | Standard |
|---|---|
| Checkout now renders an **error summary** above the form on a failed validation pass: a heading that counts the problems and a list where every entry is a link to the offending control. Focus moves to the summary. `shouldFocusError` is turned off so react-hook-form does not fight that focus move. | 3.3.1, 3.3.3 Error Suggestion, 2.4.3 Focus Order |
| A repeated failure bumps a counter, so the summary is re-focused (and re-read) even when the same fields fail twice — the common case for a mistyped email. | 3.3.1 |
| The waiver had a single line at the *bottom* — "Please initial all required sections" — with no way to find which ones. It now has the same focused summary, listing each unmet clause by number and title, each linking to its initials box. | 3.3.1, 3.3.3 |
| Lookup failures now take focus. | 3.3.1 |
| Error summaries deliberately do **not** carry `role="alert"`. An alert that is also focused is announced twice; moving focus to a labelled container announces it once. Async failures that appear without a focus move (payment decline, waiver POST failure) keep `role="alert"`. | 4.1.3 Status Messages |

### 1.4 Focus management on state changes

| Change | Standard |
|---|---|
| Signing the waiver replaced the whole form with a confirmation panel, which **dropped focus to `<body>`** — the signer was silently returned to the top of the page with no confirmation that a legal document had been executed. The panel is now focusable and takes focus. | 2.4.3, 4.1.3 |
| The guardian block appears only after a date of birth under 18 is entered. It is now inserted into a live region that is present from first render, so the newly required field is announced instead of appearing silently. | 4.1.3 |

### 1.5 Async status

| Change | Standard |
|---|---|
| Checkout submit, waiver submit, and booking lookup each gained a polite `role="status"` region announcing progress ("Processing your booking. Please wait."). On rural cell service the gap between tapping and a redirect is several seconds of a button that appears to have stopped working. | 4.1.3 |
| The waiver's "Loading waiver…" is now a `role="status"`; its load failure is a `role="alert"`; the form carries `aria-busy` while submitting. | 4.1.3 |

### 1.6 Colour contrast against the brand colour

The brand colour is **operator-supplied**, so any hardcoded white-on-brand is a
contrast bug waiting for the first operator with a light brand. The shipped
default `#0ea5e9` already fails: white on it is **2.8:1**, against a 4.5:1 floor.

| Change | Standard |
|---|---|
| The header's "Book now" CTAs now compute their label colour from the brand colour's relative luminance (white → near-black → black, first candidate that clears 4.5:1). This is provably safe for *every* possible brand colour: for any background, the better of white and black is at least 4.58:1, so a passing candidate always exists. | 1.4.3 Contrast (Minimum) |
| Footer copyright was `text-slate-400` on white — **2.6:1**. Now `text-slate-500` (4.76:1), the lightest slate that clears AA on white. Same fix for the checkout fine print and the waiver "(optional)" markers. | 1.4.3 |
| The global `:focus-visible` outline is `var(--brand-color)`, which is close to invisible on a brand-filled button. Brand-filled controls in these files now opt out and ring in `slate-900` with an offset. | 1.4.11 Non-text Contrast, 2.4.7 Focus Visible |
| The lookup form's inputs focused with `ring-brand/30` — a 30%-opacity tint of an operator-chosen colour, which cannot be relied on to reach 3:1. The brand border on focus stays; the ring is now solid `slate-900`. | 1.4.11 |

### 1.7 Keyboard operability

- Every control touched in this pass is a native `<button>`, `<input>`, `<a>`, or
  `<summary>`; nothing here needs a custom key handler, and nothing is a `<div>`
  pretending to be a control.
- The mobile menu remains a CSS-only `<details>/<summary>` disclosure: reachable
  by Tab, opened with Enter or Space, and `<summary>` already exposes its
  expanded state to assistive tech (adding `aria-expanded` would duplicate it).
  Its label was "Open menu" in both states, which is wrong once open — it is now
  just "Menu", with the state left to the native mapping.
- The waiver's date of birth is a native `<input type="date">`, keyboard-operable
  by definition. There is **no signature pad / canvas** in this flow: the
  signature is typed, which is why §1.2 spends its effort on naming instead.

### 1.8 prefers-reduced-motion

Already handled globally in `apps/web/app/globals.css`, which zeroes animation
and transition durations and forces `scroll-behavior: auto` under
`@media (prefers-reduced-motion: reduce)`. Nothing added in this pass introduces
motion that escapes it — the only animation is the shared `Spinner`, whose
duration that rule already collapses. (2.3.3, and 2.2.2 by having nothing that
auto-plays for more than five seconds.)

---

## 2. What is now enforced automatically

Everything in §1 was reasoned against the spec with no browser open. That is a claim.
`e2e/specs/accessibility.spec.ts` is what turns it into a fact — an axe-core audit plus
the assertions axe cannot make, both run against the real stack.

### 2.1 The command

```powershell
$env:SANDBOX='local'; pnpm exec playwright test e2e/specs/accessibility.spec.ts --reporter=line
```

It attaches to a stack that is already up (`pnpm dev:local`, or a production build on
:3000 / :3001 / :3002). Nothing is mocked: it books, signs and pays through the same
local drivers the owner uses.

### 2.2 What axe checks, and where the bar sits

Configured for **WCAG 2.1 Level AA only** — tags `wcag2a`, `wcag2aa`, `wcag21a`,
`wcag21aa`. `best-practice` is deliberately excluded so that an argument about whether a
best-practice finding "counts" can never become an argument about the whole suite.

| Impact | Treatment |
|---|---|
| `critical`, `serious` | **Fails the test.** |
| `moderate`, `minor` | Printed to the run output and attached to the report; does not fail. |

The lower band is reported rather than ignored, and the upper band never moves. A suite
that failed on every impact would have been narrowed to a passing subset within a week;
a suite that failed on nothing would be decoration. Each audit also writes its complete
axe JSON as a test attachment, so a finding can be chased without re-running.

Twelve surfaces are audited, each in the state a person actually meets it in — a loaded
date strip, not a skeleton; a checkout that has just failed validation, not a blank one:

| Surface | Notes |
|---|---|
| Catalog home | |
| Activity detail | Rate, date **and** time chosen; date strip settled (`aria-busy="false"`) |
| Checkout | Initial state |
| Checkout | After an invalid submit — what a screen reader gets when the button "does nothing" |
| Confirmation | Real order, created through the API |
| Waiver — loaded | |
| Waiver — unmet requirements | Blocked submit, summary showing |
| Waiver — minor / guardian | DOB under 18 entered, guardian block open |
| Waiver — signed | The confirmation panel that replaces the form |
| Embed booking widget | 360 × 740 viewport, the document `public/embed.js` frames |
| Admin manifest | The screen dock staff use all day |
| Admin order detail | |

### 2.3 What is asserted directly, because axe cannot see it

Axe is a static pass over one rendered tree. It cannot tell you that focus went nowhere,
that Tab walked out of a modal, or that a spinner replaced a control with an unnamed
box. Those are asserted explicitly:

| Assertion | Why it is not an axe rule |
|---|---|
| **Focus order** through the booking widget walks rate → date → time → CTA, entering each group once, and reaches "Continue to checkout" by keyboard. | Axe reads the DOM; it has no opinion about the order Tab visits it in. |
| **Focus moves to the error summary** after a failed checkout submit and after a blocked waiver signature, and every summary entry links to a control that exists. | A silent failure is valid HTML. |
| **Invalid fields carry their reason**: every `aria-invalid` control resolves an `aria-describedby` to real text, and no `aria-describedby` dangles. | Axe checks that a description resolves, not that a field has one. |
| **The embed overlay traps focus** — two Shift+Tabs off the first stop and twelve Tabs forward all stay inside the widget — and **returns focus to the launcher** on Escape. | Cross-origin, inside a shadow root; a static scan cannot follow it. |
| **Visible focus indicators** on the rate, date, time, CTA, first-name field and "Complete booking", measured under real keyboard modality (`:focus-visible`), not a programmatic `.focus()`. | The global outline is the *operator's brand colour*, which can be invisible on a brand-filled control. |
| **The date strip's loading state is labelled**: with the range request held open, the group reports `aria-busy="true"` and every placeholder day announces "checking availability" — and the time picker's visually hidden "Loading available times…" is present while its own request is held. | Both states are transient; axe would scan the resolved page and see nothing. |
| **The skip link has a target** and actually moves focus. | `skip-link` is a `best-practice` rule, excluded above — so it is asserted here instead. |
| **The whole checkout can be completed with the keyboard alone**, and the submit announces "Processing your booking" while it works. | Operability is a behaviour, not a markup property. |
| **Every initials box on the waiver is named with its clause**, and no two share a name. | Axe sees twelve accessible names; only this sees that they are twelve *distinguishable* legal acknowledgments. |
| **The guardian field appears inside a polite live region**, is `aria-required`, and carries a description. | An insertion is announced only if the region existed first; a static scan cannot tell. |

The spec **fixes nothing in the product** by design. Findings are reported, not tuned
away, and nothing in it may be relaxed to make a run green.

---

## 3. What the audit finds today — the run is RED, and correctly so

Last run: **9 of 15 tests failed**, 12 surfaces audited, **11 serious/critical axe
violations across ~253 failing nodes**, and **0 moderate/minor**. Node counts move a
little with the seed — the manifest's unlabelled selects are one per timeslot on the
day being viewed — but the eleven violations themselves are stable run to run. Every one
is a real product problem in a file outside the five §1 touched, and each is listed with
its fix.

### 3.1 axe findings

| Surface | Rule | Impact | Nodes |
|---|---|---|---|
| Catalog home | `color-contrast` | serious | 53 |
| Activity detail | `color-contrast` | serious | 27 |
| Checkout (initial) | `color-contrast` | serious | 4 |
| Checkout (initial) | `scrollable-region-focusable` | serious | 1 |
| Checkout (validation errors) | `color-contrast` | serious | 4 |
| Checkout (validation errors) | `scrollable-region-focusable` | serious | 1 |
| Confirmation | `color-contrast` | serious | 2 |
| Embed widget @360px | `color-contrast` | serious | 25 |
| Admin manifest | `color-contrast` | serious | 33 |
| Admin manifest | `select-name` | **critical** | 96–97 |
| Admin order detail | `color-contrast` | serious | 7 |
| Waiver — all four states | — | — | **0** |

The waiver — the screen that takes the legal signature, and the one §1 spent most of its
effort on — is **clean in all four of its states**, including the minor/guardian path.

### 3.2 The findings, by cause

**A. `select-name` — 96 unlabelled selects on the manifest. CRITICAL.**
`apps/admin/components/manifest/GuideScheduler.tsx:113` renders a guide-assignment
`<select>` per timeslot with no `<label>`, no `aria-label` and no `title`. On a busy day
that is ninety-odd controls a screen reader announces as a bare "combo box". Fix: an `aria-label`
naming the activity and time — the row already has both values in scope.
(4.1.2 Name, Role, Value.)

**B. `text-slate-400` (#94a3b8) on white or slate-50 — 2.45–2.56:1, needs 4.5:1.**
The single biggest source of nodes. §2.7 of the previous pass named two files; the audit
shows it is systemic — roughly two dozen components across `apps/web`, including
`components/catalog/ActivityCard.tsx:89,121,126`,
`components/catalog/CatalogBrowser.tsx:219`, `components/activity/RateCards.tsx:110`,
`components/checkout/OrderSummary.tsx:111`, `components/checkout/PaymentSection.tsx:123`,
`components/checkout/PriceBreakdown.tsx:84`, `components/checkout/WalletExpress.tsx`
(four sites), `components/embed/EmbedShell.tsx:82`,
`components/embed/EmbedConfirmation.tsx:112`, and
`app/confirmation/components/InfoPanels.tsx`. `text-slate-500` (#64748b, 4.76:1 on
white) is the drop-in fix — and this is worth a lint rule rather than two dozen edits
that will regress. (1.4.3.)

**C. White text on the operator's brand colour — 2.77:1 with the shipped default.**
`apps/web/components/activity/RateCards.tsx:75` hardcodes `text-white` on a badge
painted with `accentColor`, and `packages/ui/src/badge.tsx:12` and
`packages/ui/src/button.tsx:15` do the same with `bg-[var(--brand-color,#0f766e)]
text-white`. This is §2.4 of the previous pass, now measured: the audit catches it on
the activity page and in the embed. The systemic fix is still one variable —
`brandStyle()` in `apps/web/lib/brand.ts` emitting `--brand-foreground` using the
luminance helper already written in `SiteHeader.tsx`. (1.4.3.)

**D. Admin greys on the admin's own backgrounds.**
`apps/admin/components/shell/Sidebar.tsx:145` — `text-slate-500` (#64748b) on
`bg-slate-900` is **3.75:1**. `apps/admin/components/shell/PageHeader.tsx` — the same
slate-500 on the `#f1f5f9` page background is **4.34:1**.
`apps/admin/app/manifest/page.tsx:88` — the summary-chip labels apply `opacity-70` to
`text-slate-700`, which composites to #707a88 on white, **4.34:1**. Opacity on text is
the trap here: the colour that ships is not the colour in the class. (1.4.3.)

**E. `scrollable-region-focusable` — the waiver text box cannot be scrolled by keyboard.**
`apps/web/components/checkout/WaiverSection.tsx:35` is a `max-h-44 overflow-y-auto` div
holding the waiver copy, with no focusable content and no `tabindex`. A keyboard or
screen-reader user **cannot read the legal text they are about to accept**. Fix:
`tabIndex={0}` plus a named `role="region"`. Given what the box contains, this is the
most serious finding on the customer side. (2.1.1 Keyboard.)

### 3.3 Findings axe cannot see, caught by the explicit assertions

**F. The checkout error summary never receives focus. (New — not previously known.)**
`apps/web/components/checkout/CheckoutClient.tsx:301` focuses the summary from an effect
keyed on `[invalidCount]`, but the summary only mounts when
`showErrorSummary = invalidCount > 0 && fieldErrors.length > 0`. On the render where
`invalidCount` becomes 1 the div is not in the DOM yet, so `errorSummaryRef.current` is
`null` and the focus call is a no-op; the later render that does mount it never re-runs
the effect, because `invalidCount` has not changed. Verified in the browser: after a
failed submit the only `focusin` event on the page is the submit button's own, and focus
stays on "Complete booking". **The whole intent of §1.3 is currently not reaching a
guest.** Fix: include the summary's presence in the dependencies
(`[invalidCount, showErrorSummary]`), or focus from a callback ref on mount. The same
pattern in `WaiverSigner.tsx` works, because its `problems` are derived synchronously in
the same render. (3.3.1, 2.4.3.)

**G. Checkout field errors are still not bound to their inputs.** Confirms §2.2 of the
previous pass, now with numbers: five invalid controls — `#firstName`, `#lastName`,
`#email`, `#participant-0-name` and the waiver checkbox — announce "invalid" with no
reason attached. `apps/web/components/checkout/FieldError.tsx` renders `<p role="alert">`
with no `id` for a caller to point `aria-describedby` at. (3.3.1.)

**H. The waiver-acceptance checkbox has no `id`.** Confirms §2.3. Its entry in the error
summary is the only one that renders as plain text instead of a link, and the audit
reports it by name: *"Liability waiver: You must accept the waiver to continue"*, with no
anchor. Adding `id="waiverAccepted"` in
`apps/web/components/checkout/WaiverSection.tsx` is the whole fix. (3.3.1.)

**I. The skip link points at nothing.** Confirms §2.1, and the audit shows all three
consequences in one run: no element has `id="main-content"`; there is therefore nothing
carrying `tabIndex={-1}` to receive focus; and activating the link leaves focus on the
link itself. It consumes the first tab stop of every customer page and bypasses nothing.
Every `<main>` listed in the previous §2.1 still needs `id="main-content"` and
`tabIndex={-1}`. (2.4.1.)

### 3.4 What the audit proved is working

Not a footnote — these were claims in §1 and are now checked on every run:

- The waiver's four states are clean at AA; initials boxes are named per clause and no
  two share a name; the guardian field is announced from a live region that was present
  from first render; focus lands on the confirmation panel after signing.
- A blocked waiver signature moves focus to its summary.
- The embed overlay traps focus in both directions and returns it to the launcher.
- Focus order through the booking widget matches the visual order and reaches the CTA.
- Every focus indicator checked is visible under real keyboard focus.
- The date strip and the time picker both announce themselves while loading.
- Checkout can be completed end to end with the keyboard alone, and announces progress.
- **Zero** moderate or minor violations anywhere.

### 3.5 Gaps the audit does not yet reach

Still open from the previous pass, and outside what this run can see:

- **`readableTextOn()` in `apps/web/components/catalog/color.ts`** picks black or white
  from a `luminance > 0.5` threshold rather than a contrast ratio, so it returns white
  for `#0ea5e9` (2.8:1). It drives activity-card headers; the catalog's contrast nodes
  are dominated by slate-400, so this one is not separately isolated by the run yet.
- **`packages/ui/src/dialog.tsx`** neither traps focus nor restores it on close
  (`RescheduleDialog`). The embed overlay is audited; this dialog is not.
- **The date and time pickers use `role="radio"` without a roving `tabindex`.** The
  audit confirms they are operable and in the right order — 14 days is 14 tab stops —
  but the radiogroup pattern expects arrow-key navigation. Not an AA failure; it is the
  biggest keyboard-efficiency win left.
- **Checkout renders no `SiteHeader`/`SiteFooter`**, so it has no banner or contentinfo
  landmark and no skip link. Worth a decision.
- **Brand-coloured focus rings** (`globals.css`, `ui/input.tsx`, `ui/button.tsx`) may
  fall below 3:1 for a light brand. The audit asserts a ring is *visible*, not that it
  clears 3:1 against its own background.

---

## 4. What still needs a human with a real screen reader

Nothing below can be settled by axe or by Playwright. Test on the local stack, with the
**default** brand colour and again with a deliberately light one
(e.g. `BRAND_COLOR=#f5d90a`).

1. **NVDA + Firefox, and VoiceOver + Safari on iOS**, full booking: catalog → date →
   time → checkout → pay. iOS Safari is the device class this product targets.
2. **The waiver, end to end, by voice only.** The audit proves each initials box is
   *named* with its clause; only a person can confirm the naming is *comprehensible* at
   speed, and that an unmet box announces both "required" and "invalid".
3. **Double-announcement check.** The focused summaries must be read exactly once, and
   the `role="alert"` boxes (payment decline, waiver POST failure) exactly once. §1.3
   picked one mechanism per case for this reason. Note that finding **F** means the
   checkout summary is currently not announced at all — retest after that fix.
4. **Guardian field announcement.** The audit proves the live region exists and that the
   field lands inside it; a person still has to confirm it is announced without stealing
   focus mid-typing.
5. **200% zoom and 320px reflow** of checkout's two-column rail (1.4.10). The audit runs
   the embed at 360px but does not zoom.
6. **Colour meaning without colour.** The availability legend (green / amber / rose)
   carries text labels, but the dots on the date cells do not; confirm the spoken day
   labels alone are enough.
7. **Legal copy review.** "Typing your full legal name here is your signature on this
   waiver" is product copy, not reviewed legal text. Per the build contract, `/terms`,
   `/privacy` and the waiver copy still need a real legal review, and nothing here
   should imply otherwise.

---

## 5. What is still not verified

- **Contrast is now measured, not computed** — every ratio in §3 came from axe against a
  rendered page. The ratios quoted in §1 were hand-computed and have not all been
  re-sampled.
- **One brand colour.** The whole audit runs against the seeded operator's `#0ea5e9`.
  The brand-dependent findings (C, and the focus-ring gap in §3.5) get worse with a
  lighter brand and are not yet run against one.
- **One viewport per surface**, plus the embed at 360px. No zoom, no reflow, no
  landscape phone.
- **Chromium only.** Firefox and WebKit are not in the Playwright project list, so
  nothing here says anything about VoiceOver's actual behaviour on Safari.
- **Customer self-service** (`/account`, `/account/bookings`) and the rest of the admin
  console are not yet in the audit's surface list.
