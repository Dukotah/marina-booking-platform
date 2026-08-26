# Singenuity Parity & Beat-Them Matrix

Source: read-only functional/architecture audit of Singenuity (Lake Sonoma Marina
tenant), 2026-07-13. This is the "don't miss anything" checklist for reaching
feature parity and then beating them. Status reflects our platform as of 2026-07-13.

Legend: ✅ have · 🟡 partial · ❌ missing · ⭐ we're already ahead

## 0. Structural verdict — we start ahead

Singenuity is **split-brain**: a legacy ASP.NET MVC console (config) + a separate
modern SPA register (ops), two stacks, duplicated validation/logic. Their own audit's
top recommendation is "collapse into one API-first SPA."

- ⭐ **We are already that** — one Hono `/api`, one admin SPA (config AND ops in the
  same app), one customer SPA. Their target architecture is our starting point.
- ⭐ **RBAC**: they use 9 single-assignment roles; the audit flags single-role as a
  weakness and recommends composable permission scopes. We already have roles +
  `extra_permissions` (composable). Keep this edge; don't regress to single-role.
- ⭐ Config UX: their Activity "General" tab crams a huge toggle wall; their dropdowns
  are unfiltered long lists. Our chance to win on UX (type-ahead, grouped tabs).
- Keep their sound boundaries: externalized media (they use Cloudinary → we use R2)
  and payments (they use Square → we use Stripe).

## 1. Products

| Singenuity | Us | Action |
|---|---|---|
| Activities (11 config tabs) | ✅ activities + rates + schedules/timeslots + fees + waivers + photos + self-reschedule | 🟡 add: per-activity message/email-text templates, tips config, **package upsells** |
| Rates (internal/external/online, from-price) | ✅ name_internal/external, online_only/internal_only, fromPrice | at parity |
| Capacity type: Time / Duration / Rate | 🟡 timeslot (Time) + rate durations + resources | confirm Duration mode; document mapping |
| Per-channel visibility (online/register/display/kiosk, hide price) | 🟡 `visible_online` only | ❌ add register/display/kiosk + hide-price flags |
| Packages | ❌ | **build** (Task #6/#8) |
| Package upsells (at checkout) | ❌ | **build** (attach to checkout) |
| Gift **Cards** (stored value) | ✅ backend built (GiftCard, issue/redeem/liability) | wire UI (checkout apply, buy page, admin) |
| Gift **Certificates** (fixed value / specific product) | ❌ distinct from gift cards | **build** (Task #8) |
| Merchandise | ✅ POS + inventory | at parity |
| Rentals | 🟡 modeled as activities | consider distinct rental type/flags |
| Resources | ✅ shared-capacity engine (cross-activity blocking) | ⭐ at/above parity |
| Memberships | ❌ | **build** (Task #6) |

## 2. Booking / POS / ops

| Singenuity | Us | Action |
|---|---|---|
| Register Bookings day view (status/activity/date filters, utilization badges) | ✅ manifest (list + Gantt) + calendar, check-in/no-show | 🟡 add utilization badges (booked/total, timeslot fill) |
| Sell (POS): catalog→date→rate/qty→cart→checkout | ✅ POS (bookings + merch, cash/card/comp) | 🟡 add packages + gift card as tender + cart multi-item |
| Waivers (+ minor age ranges) | ✅ digital waiver + minor signature + DOB | 🟡 add minor age-from/to ranges |
| Tips | ✅ checkout + POS | at parity |
| Self-reschedule rules | ✅ self_reschedule_hours + customer UI | at parity |
| Orders (history, modify, refund) | ✅ orders + refunds + audit | at parity |
| Manager-approval for payments/refunds over threshold | ❌ | **build** (Task #5) — RBAC-gated approval |
| Guide scheduling (+ Google Calendar sync, email/SMS notify) | ❌ (GUIDE role exists only) | **build** (Task #5) |

## 3. Reports

| Singenuity | Us | Action |
|---|---|---|
| Sales: Gross, Taxes & Fees, Tips, Merchandise, Packages, Payments | 🟡 revenue + taxes/fees + occupancy + CSV | ❌ add tips, merchandise, packages, payments breakdowns |
| Date basis: appointment date vs order date | ❌ | **add toggle** |
| Granularity: Summary / Items / Details, activity grouping, resource filter, GL account | 🟡 | add granularity + grouping + GL |
| Comparison vs another date range | ❌ | add compare mode |
| Gift Cards / Memberships / Gift Certificates reports | 🟡 gift-card liability total built | build dedicated reports |
| Insights | ❌ | later |

## 4. Settings / configuration

| Singenuity | Us | Action |
|---|---|---|
| General (timezone/country/culture), branding/logo | ✅ branding + policies + locations | 🟡 type-ahead pickers (beat their long lists) |
| Payments & Refunds (thresholds, approval) | 🟡 | add refund/payment approval thresholds |
| Integrations | 🟡 catalog (Stripe/Resend/Twilio/QB/GA4/Meta/Mailchimp) | wire the rest incrementally |
| Booking Settings | 🟡 | consolidate |
| Taxes & Fees | ✅ global + per-activity | at parity |
| Emails / Message Templates | 🟡 branded emails, SMS | ❌ operator-editable templates |
| Booking Notifications | ✅ email + SMS (confirmation + reminders) | ⭐ SMS is a lead vs many configs |
| Waiver config | ✅ | at parity |
| Discounts / Promo Codes | ✅ | at parity |
| Affiliates | ❌ | build |
| Users & Permissions | ✅ RBAC + extra_permissions | ⭐ composable already |
| Heard About Us | ❌ | build (customer attribution field) |
| Transportation | ❌ | build (activity option) |
| Customer Questions (custom fields) | ❌ | build |
| General Ledger (GL accounts) | ❌ | build (for accounting export) |
| Guide Roles | ❌ | build (with guide scheduling) |
| Blackout days | ❌ | build |

## 5. Integrations

| Singenuity | Us | Action |
|---|---|---|
| Square (Apple/Google Pay) | Stripe (+ wallets at go-live) | keep Stripe; add wallets |
| Cloudinary (media transforms) | R2 (planned) | wire at go-live |
| Mailchimp, GA4, Meta Pixel, Google Ads, etc. | catalog only | wire incrementally |
| Intercom (chat), Pingdom (RUM), Google Maps | ❌ | nice-to-have |
| SMS/texting | ✅ Twilio (built) | at/above parity |
| Google Calendar (guide sync, BETA) | ❌ | build with guide scheduling |

## 6. Net-new work this audit surfaces (folded into tasks)

- Packages + package upsells (#6/#8)
- Gift certificates, distinct from gift cards (#8)
- Memberships (#6)
- Guide scheduling + calendar sync + guide notifications + guide roles (#5)
- Manager-approval workflow for payments/refunds over threshold (#5)
- Per-channel visibility flags + hide-price (#8 config)
- Reports parity: tips/merch/packages/payments, date-basis, comparison, GL, gift-card/membership reports (#9)
- Config parity: customer questions, affiliates, message templates, transportation, heard-about-us, blackout days, GL accounts (#10)
- Keep/press our edges: unified API-first SPA, composable RBAC, built-in SMS, resource engine, better config UX (type-ahead, no toggle walls).
