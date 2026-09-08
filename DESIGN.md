# Design System — "Estate" · Marina Booking Platform

The design source of truth. Read this before ANY visual or UI change in `apps/web`
(customer) and, once the second pass lands, `apps/admin`. Do not deviate without
explicit owner approval.

## Product context
- **What:** white-label marina/outdoor-activity booking SaaS. First live tenant: Lake Sonoma Marina (pontoons, fishing boats, kayaks, jet skis, day-use sites).
- **Who:** renters on their phones deciding in minutes; marina staff running the dock.
- **North star (owner-chosen):** "Effortless speed" — the memory is *"I booked a boat in 30 seconds."*
- **Competitors:** FareHarbor, Peek, Singenuity — all look like utility software. We look like hospitality.

## Aesthetic direction
- **Direction:** Estate — wine-country boutique hotel. Unhurried, soft-spoken, generous air, quietly premium.
- **Decoration level:** minimal-intentional. Typography and whitespace do the work; one soft card shadow is the only depth.
- **Mood:** checking into a boutique inn that happens to hand you boat keys. Calm confidence, zero urgency theater.
- **Chosen over** (owner saw all five side-by-side): Slip Board (rustic sand/ember), Night Harbor (dark/brass), Regatta (sport navy/orange), Chart Room (heritage teal chart).

## Speed mechanics (layout is part of the brand — keep these regardless of styling)
1. **Availability is displayed, never queried.** The homepage leads with "Today's Departures": real next-available slots (time · boat · seats · all-in price · Reserve), soonest first, with a horizontal day rail. First Reserve button reachable without scrolling.
2. **Detail page = Airbnb anatomy.** Photos + specs left (~64%), sticky booking card right (~32%); on mobile the card collapses to a sticky bottom bar (price + CTA only).
3. **All-in prices everywhere.** Fees baked in, itemized in the card, never an asterisk.
4. **One-screen guest checkout.** No account, no password. The order summary renders as a "reservation card" that fills in as the guest types and flips into the confirmation (code, directions, add-to-calendar, waiver CTA).
5. **Every number a guest decides with** (times, prices, seats, codes) **is tabular** — `font-variant-numeric: tabular-nums`.

## Typography
- **Display: Marcellus** (400 only — it has one weight). Page titles, boat/activity names, section heads, the confirmation headline. Letter-spacing +0.02–0.06em on short headings; never for body or UI.
- **UI/Body: Figtree** 400/500/600. Everything else. `tabular-nums` on all numeric spans.
- **No third face.** No mono, no italic-serif accent words.
- **Loading:** `next/font/google` (self-hosted, `display: swap`) — never a `<link>` tag in app code.
- **Scale (px):** 13 (meta) · 14 (secondary) · 16 (body) · 19 (card titles) · 22 (section) · 28 (page title) · 36–44 (hero only). Line-height 1.15–1.25 headings, 1.55 body. Weights: Marcellus 400; Figtree 400/500/600 — nothing else.

## Color
Two tiers: primitives below → use ONLY via semantic tokens (CSS variables in globals).

| Token | Hex | Usage |
|---|---|---|
| `--bg` | `#FBF9F4` | page background (warm cream — never gray-50) |
| `--surface` | `#FFFEFB` | cards, board, inputs |
| `--ink` | `#2B241C` | espresso — all primary text, primary buttons |
| `--muted` | `#8A7F6E` | linen — secondary text, meta |
| `--hairline` | `rgba(43,36,28,.12)` | all borders (1px, one token) |
| `--accent` | `#5F7A5A` | sage — the ONE live action per view (Reserve), selected states. White text on it only at ≥15px/600 |
| `--accent-ink` | `#47603F` | sage-deep — text links, small accent text (AA on cream) |
| `--success` | `#3E7C4F` | confirmed, waiver signed |
| `--warn` | `#8F6A0E` | "2 left today", advisories |
| `--danger` | `#A93B2A` | errors, cancellations |

Rules: status colors appear only on status. One sage action per viewport; all other buttons are ink (solid) or hairline (ghost). No pure `#000`/`#FFF`. **No blue anywhere in chrome** — water lives in the photographs. No gradients, ever.

## Spacing, radius, depth
- **Spacing:** 4/8 scale only — 4, 8, 12, 16, 24, 32, 48, 64, 96. Space within a group < space around it, jumping ≥1 step. Sections breathe: 64–96px between homepage sections.
- **Radius:** buttons 8 · inputs 8 · cards/photos 14 · modals/sheets 16. One radius per component class — never mix on one element type.
- **Depth:** cards get `0 2px 14px rgba(43,36,28,.05)` + hairline. Overlays/modals get `0 4px 12px rgba(43,36,28,.10), 0 12px 32px rgba(43,36,28,.12)`. Nothing else casts a shadow. Never border+shadow+background-shift on the same surface.

## Layout
- Max content width 1120px, 24px gutters.
- Grid-disciplined; asymmetry comes from the 64/32 detail split, not decoration.
- Photography: fixed ratios (16:9 hero, 4:3 cards, 1:1 thumbs), `object-cover`, radius 14. Real boats and real lake only — a photo-less layout beats a stock photo. Text over photos needs a 40–60% espresso scrim.

## Motion
- Minimal-functional. 150–250ms, ease-out entering, ease-in leaving. Transitions on opacity/transform only.
- No scroll animations, no hover:scale, no skeleton shimmer (use shape-accurate static skeletons in `--surface`).

## States (every component ships all three)
- **Loading:** shape-accurate skeleton, not a spinner.
- **Empty:** one sentence + one action ("No departures today. See tomorrow →").
- **Error:** what happened + retry, in plain words.

## Anti-slop guardrails (hard bans)
Purple/indigo/violet anywhere · gradients (bg or text) · glassmorphism/backdrop-blur · emoji or ✨ in UI · centered-hero + 3-icon-card grid · `rounded-2xl shadow-lg` card defaults · gray-50/zinc backgrounds · badge pill above the H1 · colored card left-borders · Inter/Roboto/Open Sans/Space Grotesk/Instrument Serif/Geist · "Seamless/Effortless/Supercharge/Elevate" copy · exclamation-point CTAs ("Book Now!") · fake urgency ("Hurry!") · lorem ipsum · `hover:scale` · identical fade-in-up on every section · proportional-figure prices.

## AI prompting protocol (for any agent doing UI work here)
1. **Tokens first.** Read this file; use the semantic tokens; never invent values mid-build.
2. **Decision pass before code.** Output palette/type/layout decisions for the screen in ≤10 lines, check them against the bans, then build.
3. **One screen per pass**, real copy (Lake Sonoma inventory), all three states.
4. **One signature element per screen, maximum.** Everything else stays quiet.
5. **Screenshot-critique loop.** Render, screenshot (gstack browse), critique against this file, revise — 2–3 passes. Never ship the first render.
6. **Reference anatomy**, not vibes: Airbnb listing page for detail/booking-card; boutique-hotel restraint for the homepage; Linear/Stripe density for admin.

## Decisions log
| Date | Decision | Rationale |
|---|---|---|
| 2026-09-07 | Estate direction chosen from 5 side-by-side variants | Owner pick (D5); reads "luxury hospitality," most differentiated from utility-software competitors |
| 2026-09-07 | North star "effortless speed"; availability-first homepage kept across all skins | Owner pick (D1); the mechanics are the moat, the skin is the brand |
| 2026-09-07 | Marcellus + Figtree; no mono face | Estate variant approved as-is; Figtree tabular-nums covers numeric alignment |
