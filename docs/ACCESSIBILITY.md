# Accessibility — customer booking flow

Scope of this pass: the pages a paying customer touches — catalog shell, checkout,
waiver signing, and booking lookup — audited against **WCAG 2.1 Level AA**.

This is not a polish pass. The flow is completed one-handed, on a phone, on rural
cell service, often standing on a dock, and it ends in a **legal signature**. An
initials box a screen reader cannot distinguish from eleven identical initials
boxes is a liability problem, not a styling problem.

Files changed in this pass:

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

**The skip link needs one line per page to work** — see §2.1. Until then it is
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

## 2. Known gaps — need an owner outside these five files

These are real AA findings that I could not fix without editing files owned by
other agents in this run. They are listed in severity order.

### 2.1 The skip link has no target (`id="main-content"`)

`SiteHeader` now renders `<a href="#main-content">`. Every page's `<main>` needs
`id="main-content"` (and `tabIndex={-1}`, so focus actually lands there rather
than only scrolling):

```
apps/web/app/page.tsx:44
apps/web/app/account/page.tsx:31
apps/web/app/account/bookings/page.tsx:24
apps/web/app/activities/[id]/page.tsx:70
apps/web/app/activities/[id]/not-found.tsx:12
apps/web/app/checkout/page.tsx:35, 152
apps/web/app/confirmation/page.tsx:67
apps/web/app/privacy/page.tsx:23
apps/web/app/terms/page.tsx:23
apps/web/app/waiver/[orderItemId]/page.tsx:41
```

### 2.2 Checkout field errors are still not bound to their fields — 3.3.1

`apps/web/components/checkout/FieldError.tsx` renders `<p role="alert">` with no
`id`, so `CustomerFields`, `ParticipantFields`, and `WaiverSection` cannot point
`aria-describedby` at it. Moving focus onto a field with an error currently
announces the field and its `aria-invalid` state but **not the reason**.

Fix: give `FieldError` an `id` prop, and have each caller pass
`aria-describedby={errors.x ? errorId : undefined}` on the input. The checkout
error summary added in this pass covers the submit-time case, but per-field
description is what covers the "tab back to the field and ask why" case.

### 2.3 The waiver acceptance checkbox has no `id` — 3.3.1

`apps/web/components/checkout/WaiverSection.tsx` renders the acceptance checkbox
inside a wrapping `<label>` with no `id`. Because of that, its entry in the new
checkout error summary is the only one that renders as **plain text instead of a
link** — there is nothing to anchor to. Adding `id="waiverAccepted"` to that
input makes the entry a link; `collectFieldErrors` in `CheckoutClient.tsx`
already has the slot for it.

### 2.4 `@marina/ui` `Button variant="brand"` hardcodes white text — 1.4.3

`packages/ui/src/button.tsx` sets `bg-[var(--brand-color)] text-white`. Every
brand button in both apps — including **"Complete booking"** and **"Sign
waiver"** — inherits the same 2.8:1 failure the header CTA had, and I could only
fix it inside my own files by computing the colour locally.

The systemic fix is one variable: have `brandStyle()` in `apps/web/lib/brand.ts`
emit `--brand-foreground` alongside `--brand-color` (the luminance helper in
`SiteHeader.tsx` is the implementation, ready to move), and change the button
variant to `text-[var(--brand-foreground,#fff)]`. That also lets the local helper
in `SiteHeader.tsx` be deleted.

### 2.5 Brand-coloured focus rings may fall below 3:1 — 1.4.11

Three places make the focus indicator itself the operator's brand colour:

- `apps/web/app/globals.css` — `:focus-visible { outline: 2px solid var(--brand-color) }`
- `packages/ui/src/input.tsx` — `focus-visible:ring-[var(--brand-color,#0f766e)]`
- `packages/ui/src/button.tsx` — same ring

For a light brand these are below 3:1 against white. The same
`--brand-foreground`-style treatment (or a fixed `slate-900` ring) fixes all
three at once.

### 2.6 `readableTextOn()` is not AA-safe — 1.4.3

`apps/web/components/catalog/color.ts` picks black or white from a `luminance >
0.5` threshold. That threshold is not a contrast test: it returns white for
`#0ea5e9` (2.8:1). It drives the activity-card headers, so every card whose
activity colour is mid-tone ships failing text. Replace the threshold with the
contrast-ratio comparison used in `SiteHeader.tsx`.

### 2.7 `text-slate-400` on white is 2.6:1 — 1.4.3

Outside my files, still failing: `components/checkout/OrderSummary.tsx`
("Maximum available for this time"), `components/checkout/PaymentSection.tsx`
(the "encrypted and processed securely" line). `text-slate-500` is the fix.

### 2.8 `Dialog` does not trap or restore focus — 2.4.3, 2.1.2

`packages/ui/src/dialog.tsx` moves focus into the panel and closes on Escape,
but Tab can walk out of the dialog into the inert page behind it, and closing
does not return focus to the element that opened it. This affects
`apps/web/app/account/RescheduleDialog.tsx` — a customer changing a booking.
It also mints `aria-labelledby` ids from a module-level counter rather than
`useId()`.

### 2.9 Date and time pickers are operable but not the ARIA pattern — 4.1.2

`components/booking/AvailabilityCalendar.tsx` and
`components/activity/TimeSlotPicker.tsx` put `role="radio"` on native
`<button>`s inside a `role="radiogroup"`. Every option is individually tabbable
and activates with Enter/Space, so the flow is **operable** — but the radiogroup
pattern expects a roving `tabindex` with arrow-key navigation, and a month of
dates is 30+ tab stops. Not a hard AA failure; it is the single biggest
keyboard-efficiency win left in the funnel.

### 2.10 Checkout has no site chrome

`apps/web/app/checkout/page.tsx` renders neither `SiteHeader` nor `SiteFooter`,
so the highest-stakes page in the funnel has no `banner` or `contentinfo`
landmark and no skip link. Deliberate or not, it is worth a decision.

---

## 3. What still needs a human with a screen reader

Nothing below can be settled by reading code. Test on the local stack
(`pnpm dev:local`), with the **default** brand colour and again with a
deliberately light one (e.g. `BRAND_COLOR=#f5d90a`).

1. **NVDA + Firefox and VoiceOver + Safari on iOS**, full booking: catalog →
   date → time → checkout → pay. iOS Safari is the device class this product
   targets; VoiceOver's handling of the focused error summary is the specific
   thing to confirm (that it reads the whole list, once).
2. **The waiver, end to end, by voice only.** Confirm each initials box announces
   its clause number and title, that a required-but-empty box announces both
   "required" and "invalid", and that the confirmation panel is announced after
   signing. This is the highest-liability screen in the product.
3. **Double-announcement check.** Confirm the focused summaries are read exactly
   once and the `role="alert"` boxes (payment decline, waiver POST failure) are
   read exactly once — §1.3 chose one mechanism per case for this reason, and
   only a real screen reader can confirm the choice was right.
4. **Guardian field announcement.** Enter a date of birth under 18 and confirm
   the newly required guardian field is announced without stealing focus mid-typing.
5. **Automated axe/Lighthouse run** once Playwright lands (Phase 0 §4.5). The
   contract already commits to Lighthouse accessibility 100 in CI (Phase 2); the
   §2 gaps above are what will keep that score below 100 until they are fixed.
6. **200% zoom and 320px width** reflow of checkout's two-column rail (1.4.10) —
   the layout was not touched in this pass and was not verified.
7. **Legal copy review.** The new signature description ("Typing your full legal
   name here is your signature on this waiver") is product copy, not reviewed
   legal text. Per the build contract, `/terms`, `/privacy`, and the waiver copy
   still need a real legal review, and nothing here should imply otherwise.

---

## 4. What was *not* verified in this pass

- No browser was opened; no screen reader was run. Everything in §1 is a code
  change reasoned against the spec, verified only by `npx tsc --noEmit` passing
  in `apps/web`.
- Contrast ratios quoted here were computed from the WCAG relative-luminance
  formula, not sampled from a rendered page.
- `pnpm build`, `pnpm dev`, and the test suite were deliberately not run (shared
  Prisma engine, ports, and database with other agents in this run).
