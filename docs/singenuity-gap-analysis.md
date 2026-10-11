# Singenuity Gap Analysis — Generic Booking/Rental Platform Bones

Repo: `/home/dukotah/marina-demo` · branch `demo/lakesonoma-live` · read-only analysis.
Scoring lens: rank by value to **any** booking/rental operator, not Lake-Sonoma-resort specifics. De-prioritize transportation/kiosk/affiliate/OTA/org-group/photo-system features unless cheap and broadly useful.

---

## Headline verdict

The generic bones are **strong and mostly already competitive** with Singenuity — in several places we are flat-out better. The pool/resource engine, duration-based blocking, recurring ScheduleRule templates, deposits + pay-balance-later, 3DS/SCA, promos, add-on engine, reconciliation report, immutable waivers, composable RBAC, and (contrary to one agent's claim) **real wallet pay and a real QR encoder** are all built. The gaps that actually matter are a short list: **(1) no tiered cancellation/refund policy** — today we retain all money on cancel, a chargeback magnet; **(2) the open-duration rental-window is scaffolded but dark** (columns exist, no booking/availability code reads them) — this is the single most generically valuable rental capability and it's half-finished; **(3) three transactional emails don't exist** (cancellation, post-trip review, abandoned-cart) despite the exact reusable sweep machinery sitting right there; **(4) the fully-built AddOns component and real QR encoder are not wired to the live surfaces.** Fix those and the platform is genuinely switch-worthy for a general operator. Most of the rest of the Singenuity map is either already covered, presentation sugar, or resort-niche.

---

## Corrections to the source clickthrough (verified by reading code)

The Singenuity map and one domain agent made claims this analysis **overturns**:

- **Wallet pay (Apple/Google) is BUILT, not missing.** `apps/web/components/checkout/WalletExpress.tsx`, `apps/web/components/checkout/walletRequest.ts`, `apps/web/app/checkout/wallet-config.ts` implement a full `canMakePayment`-gated express button with a `sandbox`/`stripe` driver seam that reuses the same validate→createBooking→submitPayment pipeline as the card path. The notifications-domain "missing" verdict is wrong.
- **A real QR encoder is BUILT, not absent.** `packages/core/src/qr.ts` exports `encodeQr`/`qrToSvg`/`qrSvg` (+ `qr.test.ts`). The "no qrcode library" claim is false. The real gap is that `apps/web/app/confirmation/components/QrPlaceholder.tsx` still renders a fake matrix — so this is a **wire-up/finish**, not a build.
- **The customer-checkout AddOns UI is BUILT but DARK.** `apps/web/components/checkout/AddOns.tsx` is a complete, accessibility-audited controlled component and `GET /api/addons` is a public route — but `AddOns` is imported nowhere; `CheckoutClient.tsx` has no add-on state and `apps/web/app/checkout/` never renders it. So it's a **finish/wire-up**, not a from-scratch build.

---

## Gap matrix by domain

Status legend: **built** = done end-to-end · **partial** = exists but incomplete/dark · **missing** = not present.

### Activities / Rates / Schedules

| Feature | Status | Evidence (file cites) | Generic value | Effort | Rec |
|---|---|---|---|---|---|
| Duration-based resource blocking (rate duration holds the asset) | built | `schema.prisma` Rate.duration_minutes L412; `services/booking.ts:395` bookingWindow; `services/availability.ts` seatsReservedIn/resolveTrueCapacity L346-415 | high | S | have |
| Capacity TYPE selector (Time/Duration/Rate enum) | partial | implicit: Timeslot.capacity_total L434, Resource.seat_capacity+quantity L542-543, rate duration window; no `capacity_type` field | low | M | **skip** (UI framing over mechanics we already implement) |
| **Rate CLASSES / participant types (adult/child/senior)** | **missing** | one rateId + one quantity `booking.ts:307-312,540`; no rate_class/participant_type in schema | **high** | L | **add** (switch-blocker) |
| Internal-only / online-only rates | built | `schema.prisma` Rate.internal_only/online_only L414-415; catalog filter `routes/activities.ts:23,92`; `StepRates.tsx:137-146` | high | S | have |
| Conditional rates (show/price by date/channel/membership) | partial | PricingRule adjusts (not hides); only static online_only/internal_only flags gate visibility | med | M | finish (low priority) |
| Seasonal schedule TEMPLATES (named recurring patterns) | built | ScheduleRule `schema.prisma:492-532`; `packages/database/src/schedule.ts`; admin RuleScheduler + copyScheduleFrom | high | S | have |
| Per-schedule rate PRICE override cascading to its slots | missing | ScheduleRule carries only capacity override L522; no price on Timeslot | med | M | finish-or-skip (SEASONAL PricingRule covers most) |
| Per-TIMESLOT manual overrides (close/price/hide/call-to-book) | partial | engine honors manual CANCELLED ("keptClosed" schedule.ts:467-468) but **no staff endpoint/UI** to close/edit one slot; no price/hidden/call_to_book columns | med | M | add (close-by-hand is 80% there) |
| **Open-duration RENTAL WINDOW booking** | **partial (dark)** | columns scaffolded `schema.prisma:369-375,511-520` + migrations + seed + admin editor; **no booking/availability consumer** (verified: `grep rental_open_minute/open_minute over apps/api/src = 0 hits`); `booking.ts:395` still books fixed slot+duration | **high** | L | **finish** (switch-blocker) |
| Priority-booking smart funnel (orphan/starred times) | missing | no orphan/starred logic anywhere | low | L | skip (tour-operator yield nicety) |
| Min/Max participants per BOOKING | built | Activity.min/max_participants `schema:352-353`, enforced `booking.ts:307-312` | high | S | have |
| Min/Max per RATE + require-minimum-to-run | missing | min/max only on Activity; no threshold-to-run | med | M | add (fold into rate-classes) |
| Arrive-early minutes in confirmations/reminders | missing | no arrive_early field; notifications compute from slot datetime | med | S | add (cheap, broadly useful) |

### Products (merch / gift / packages / resources)

| Feature | Status | Evidence | Generic value | Effort | Rec |
|---|---|---|---|---|---|
| Post-return ad-hoc charges (fuel/cleaning/damage/late) | built | OrderCharge `schema:962-977`; `orders/actions.ts` addOrderChargeAction 505-583; card + manifest UIs | high | S | have |
| Reusable fee-item / charge-preset catalog | missing | free-form every time; CHARGE_CATEGORIES hardcoded `actions.ts:488`; no ChargePreset model (verified 0 hits) | high | M | add |
| Merchandise line w/ snapshot reporting | built | OrderMerchandiseLine `schema:1027-1048`; POS `pos.ts:49-55,498-518`; MerchandiseReportView | high | S | have |
| Merchandise VARIANTS w/ product rollup | partial | `MerchandiseItem.variant` free-text L998-1017; rollup by name-string, no parent product/SKU | med | M | finish (low priority) |
| Merchandise retail PRICE in catalog | missing | `MerchandiseItem` has only cost_cents (verified L1008); POS hand-prices every sale | high | S | add (cheap) |
| Dedicated merch catalog admin page + stock receiving | partial | API full CRUD `routes/merchandise.ts`; surfaced only inside POS; no receiving/adjust-with-reason | med | M | finish |
| Add-ons/upsell ENGINE (per-guest/booking, stock-safe) | built | `services/addons.ts`; PackageUpsell `schema:902-928`; AddOnEditor | high | S | have |
| **Surface add-ons in CUSTOMER checkout** | **partial (dark)** | `AddOns.tsx` + public `GET /api/addons` BUILT but **not imported**; CheckoutClient has no add-on state (verified) | **high** | M | **finish (wire-up)** |
| Serialized/identified-unit tracking (engine hours, asset tag) | missing | Resource is pooled count; no Unit/serial (on uncommitted feat/vessel-scheduling branch) | med | L | finish branch (medium value) |
| Gift cards (stored-value, running balance) | built | GiftCard `schema:790-812`; `services/gift-cards.ts` atomic claim | high | S | have |
| Gift certificates (single-use) | built | GiftCertificate `schema:819-849`; service + routes + admin | med | S | have |
| **Sell gift cards/certs ONLINE** | **missing** | issuance staff-only `gift-cards.ts:88-89`, takes no payment; no web gift page | high | M | add |
| Gift card as refund destination / store credit | missing | redeemGiftCard only debits; no source=REFUND path | med | M | add (retention) |
| Gift card multi-location scoping | missing | operator_id only, no location_id | low | M | skip |
| Packages (bundle at authoritative price) | built | Package/PackageItem `schema:858-897`; POS largest-remainder | high | S | have |
| Memberships (member-rate/punch/pass) | built | Membership/CustomerMembership `schema:1159-1210` | low | S | have |
| Shared/pooled Resource engine | built | Resource/ResourceBooking `schema:535-580` overlap index | high | S | have |

### Reports

| Feature | Status | Evidence | Generic value | Effort | Rec |
|---|---|---|---|---|---|
| Settlement / ledger-vs-processor reconciliation | built | `reports/reconciliation/page.tsx` ~894 lines; ReconciliationView; every variance named | high | S | have (gap: real Stripe payout importer — payments task) |
| Payments by tender | built | End-of-Day roll-up `reports/queries.ts:931-1030`; Sales L618 | high | S | have |
| **Refunds by type + reason report** | **partial** | reason captured on OrderEvent `payments.ts:822-838`; **no report aggregates it** | high | S | **add (~half day, no schema change)** |
| Cash-drawer / register session close-out | missing | no Session/Shift/Drawer model (verified 0 hits); EOD gives expected not counted | med | L | add (only if POS cash is a real channel) |
| Gift-card liability + issued/redeemed | built | `queries.ts:1145-1160` GiftCardReport | high | S | have |
| Abandoned carts report | missing | abandoned orders are deleted `payments.ts:359`; no funnel row | med | L | skip (conflicts w/ clean-manifest design) |
| Discounts / promo-redemption report | partial | discount only as total column; no per-code breakdown | med | M | add (lower priority) |
| Daily manifest / head count | built | HeadCountReport `queries.ts:1037-1095`; departures service | high | S | have |
| Taxes & fees report | built | TaxesFeesReport `queries.ts:296-380` | high | S | have |
| Tips / gratuity report | built | tip_cents totals across Revenue/Sales/Taxes | med | S | have |
| Heard-about-us / custom-questions export | partial | data captured (Order.heard_about_us L667, question_answers L678); **no report** | med | M | add (heard-about half first) |
| Prepaid deposits / balance-due liability report | partial | deposits flow through payments; no standalone outstanding-balance report | med | S | add (mirrors gift-card liability) |
| Location multi-site roll-up | built | `reports/locations/page.tsx` LocationRollUpView | med | S | have |

### Settings / Config

| Feature | Status | Evidence | Generic value | Effort | Rec |
|---|---|---|---|---|---|
| Taxes & fees (global + per-activity) | built | Fee `schema:983`; tax = name-regex `pricing.ts:264` (fragile) | high | M | finish (promote Tax to `Fee.is_tax` flag + Customer.tax_exempt) |
| Refund REASONS (configurable list) | partial | freeform string on OrderEvent | med | S | skip (free text enough) |
| Promo codes (one/many/auto, limits, windows) | built | PromoCode `schema:1050`; routes + validate | high | S | finish (AUTO type declared but never auto-applied; PER_CUSTOMER not enforced — add PromoRedemption ledger) |
| Discounts (automatic per-segment) | partial | PricingRule + member pricing; returning-guest signal unused | med | M | skip (covered 3 ways; don't add a 4th) |
| Customer QUESTIONS (types/required/scope) | built | CustomerQuestion `schema:1656`; settings CRUD; answers L678 | high | S | finish (add show_in_confirmation + per-rate scope + DATE/PHONE types) |
| Message TEMPLATES (reusable email/SMS) | partial | 3 fixed kinds `schema:1706`; subject override only, no SMS override | high | M | finish (add channel enum + sms_body_override) |
| Booking NOTIFICATIONS (staff alerts per activity) | partial | `notifications.ts:321` emails ALL staff every booking; no per-activity filter | med | M | finish (StaffNotificationPref table) |
| Users/ROLES + permissions | built | BUILTIN_ROLES + 14 PERMISSIONS + extra_permissions[] `packages/auth` | high | S | have (more flexible than their 9 fixed roles) |
| Blackout days | built | BlackoutDate `schema:1758`; settings CRUD | high | S | have (optional: date-range) |
| Heard-about-us options | built | HeardAboutOption `schema:1739`; snapshot-on-order | med | S | have |
| GL accounts | built | GLAccount `schema:1786`; accounting export | med | S | have |
| **Cart-hold expiry / booking timer** | **missing** | no reservation-TTL; "first to book wins" `schema:459`; Resource.enable_timer is display-only | high | L | **add** (last-seat race at payment) |
| Pre-auth card holds (damage deposit) | partial | sandbox supports auth/capture; real path captures immediately; no manual-capture wiring | med | L | skip (deposit+balance covers most) |
| Marketing integrations (GA4/pixel/Mailchimp) | partial | generic Integration model `schema:1256`; no injection service | low | M | skip |

### Register / POS / Self-service

| Feature | Status | Evidence | Generic value | Effort | Rec |
|---|---|---|---|---|---|
| Day manifest w/ header counters + one-tap filters | built | `manifest/CommandCenter.tsx`; ManifestViews 5 stat filters | high | S | have |
| Week manifest (7-col grid) | built | `calendar/page.tsx` WeekCalendar | high | S | have |
| Month manifest view | missing | `calendar/page.tsx:37` only day/week (verified) | med | M | skip (density nicety) |
| Saved views (named presets) | missing | filter state in-memory only | low | M | skip |
| Grouped-by-activity toggle | partial | Schedule Gantt already gives spatial board | low | S | skip |
| Open-slot inline open-register / book-now | built | `OpenSlotBlock.tsx` → /pos prefilled | high | S | have |
| Per-slot open/hide/call-to-book controls | partial | fleet out-of-service exists; hide_price = call-to-book | med | M | skip |
| Per-slot message-all guests | missing | no bulk message surface | med | M | add (weather delay) |
| Per-slot bulk check-in / no-show-all | missing | one orderItemId each | med | S | add (cheap: boarding = one tap) |
| Per-slot print manifest/roster | partial | order-level waiver-packet print only | med | S | add (dock boarding list) |
| Booking menu: edit/reschedule (staff) | built | ReservationCard RescheduleSection; `orders.ts:487` | high | S | have |
| Booking menu: add note | built | ReservationCard NotesSection | high | S | have |
| Booking menu: no-show + check-in/undo | built | ReservationCard L328-353 + OrderEvents | high | S | have |
| Booking menu: add fuel/ad-hoc charge | built | ReservationCard L764 addOrderChargeAction | high | S | have |
| Booking menu: message THIS guest (one-off) | missing | card has no message button | high | M | add (shares backend w/ slot broadcast) |
| Self-service RESCHEDULE (customer) | built | `orders.ts:534` self-reschedule; RescheduleDialog + magic-link | high | S | have |
| **Tiered cancellation policy + fee** | **missing** | cancelBooking restores capacity only `booking.ts:838`; staff cancel RETAINS money `orders.ts:379`; no self_cancel_hours/tiers/fee | **high** | L | **add (switch-blocker, highest leverage)** |
| **Self-service CANCEL (policy-enforced)** | **partial** | web is a mailto only `manage-panel.tsx`; cancelBooking + magic-link session exist to hang it on | **high** | M | **finish (ship with tiered policy)** |
| Self-service SWAP to another activity (reprice) | missing | reschedule same-activity only `booking.ts:973-980` | low | L | skip (staff cancel+rebook covers it) |
| QR check-in (scannable → check in at dock) | partial | **real encoder `packages/core/src/qr.ts` BUILT**; `QrPlaceholder.tsx` still fake; manual tap works | med | M | finish (wire encoder + signed-token scan endpoint) |
| POS/register terminal (cart, payment, manager approval) | built | `pos/page.tsx` + components; `pos.ts` 724 lines; approval gate `orders.ts:411-436` | high | S | have |

### Notifications / Payments / Booking

| Feature | Status | Evidence | Generic value | Effort | Rec |
|---|---|---|---|---|---|
| **Wallet pay (Apple/Google)** | **built** (corrects "missing") | `WalletExpress.tsx`, `walletRequest.ts`, `wallet-config.ts` — canMakePayment-gated, sandbox/stripe driver, reuses card pipeline | high | — | have |
| **Post-trip follow-up / review-request email** | **missing** | no review/follow-up template (verified 0 hits); reminder sweep fires BEFORE only | high | M | **add** (reuse reminder sweep) |
| **Cancellation email/SMS to customer** | **missing** | cancelBooking sends nothing (verified 0 hits); only refund receipt exists | high | S | **add** (trivial given plumbing) |
| **Abandoned-checkout capture + recovery** | missing | releaseDeclinedOrder deletes the order `payments.ts` | med | M | add (upsert row before delete) |
| 3DS / SCA full round trip | built | `payments.ts` /charge requiresAction + /confirm; stripe-provider preserves intent | high | S | have |
| Deposits + pay-balance-later | built | `booking.ts` takeDeposit/collectBalance w/ FOR UPDATE lock | high | S | have |
| Promo codes at checkout | built | `routes/promos.ts` + server re-validate + atomic times_redeemed | high | S | have |
| Add-ons at checkout (engine) | built | `services/addons.ts` + GET /api/addons | high | S | have (UI wire-up tracked above) |
| Booking confirmation email + SMS | built | `notifications.ts` sendBookingConfirmation + sms.ts | high | S | have |
| Pre-arrival reminder (email+SMS, idempotent) | built | `notifications.ts` runAllDueReminders + REMINDER_SENT partial-unique claim | high | S | have (the reuse template) |
| Staff new-booking alert | built | sendStaffNewBooking | med | S | have |
| Editable message templates (operator override) | partial | resolveTemplate; only confirmation uses override; body_override effectively unused | med | S | finish |
| Per-activity notification config | missing | reminder lead is cron-wide | low | M | skip |
| Multi-language templates | missing | English only | low | L | skip |
| Square provider | n/a | clean seam; not implemented | low | L | skip (sales-driven) |

---

## Ranked: generic must-adds (by value / effort, switch-blockers first)

1. **Tiered cancellation policy + refund-on-cancel** (high / L, **switch-blocker**). Retaining 100% on cancel is a chargeback and support magnet. This is the single highest-leverage gap.
2. **Self-service cancel (policy-enforced)** (high / M, **switch-blocker**). Ships with #1; deflects the #1 phone call. Infra (cancelBooking + magic-link) already exists.
3. **Finish open-duration rental-window booking** (high / L, **switch-blocker**). Columns + admin are dark; "rent a kayak 10am for 2h" is the core rental verb. The pool engine already does arbitrary-window overlap.
4. **Cancellation email/SMS** (high / S). Trivial — reuse the confirmation/refund plumbing.
5. **Post-trip review-request email** (high / M). Reuse the reminder sweep verbatim; highest-ROI growth email.
6. **Wire AddOns into customer checkout** (high / M). Component + public route built; margin engine is dark on the highest-attach surface.
7. **Rate classes / participant types (adult/child/senior)** (high / L, **switch-blocker**). Table-stakes per-head pricing; biggest activities-domain gap.
8. **Cart-hold expiry / booking timer** (high / L). Prevents the last-seat race during checkout dwell.
9. **Sell gift cards/certs online** (high / M). Pure prepaid revenue; today only staff-issued out-of-band.
10. **Merchandise retail price in catalog** (high / S). Cheap; ends hand-pricing every counter sale.
11. **Refunds-by-reason report** (high / S). ~half day, no schema change; data already on OrderEvent.
12. **Reusable charge-preset catalog** (high / M). Stops retyping fuel/cleaning/damage lines.

---

## Where we win (already better than Singenuity)

- **Composable RBAC** — 5 roles + per-member `extra_permissions[]` overrides, enforced end-to-end (`packages/auth`), is strictly more flexible than their 9 fixed roles.
- **Pool/resource engine** — pure two-prefix-sum overlap math over a rate's duration window (`services/availability.ts`), generic to boats/kayaks/bikes/equipment, with a real overlap index.
- **Reconciliation report** — day-by-day ledger-vs-processor with every variance named (UNLINKED, AMOUNT_MISMATCH, DISPUTE_HELD, TIMING…); strongest report in the suite.
- **3DS/SCA correctness** — intent id + client_secret preserved on requires_action, re-read on confirm (not trusting the client); challenged and unchallenged bookings share one settle path.
- **Idempotent notification sweeps** — REMINDER_SENT claimed via a partial-unique index so concurrent crons can't double-send; a clean reuse template for the three missing emails.
- **Race-safe promo redemption** — atomic guarded `times_redeemed` UPDATE with guarded decrement on cancel so an abandoned booking never burns a code.
- **Wallet pay with a local sandbox driver** — Apple/Google Pay testable on a laptop with no account, same token shape as the card path.
- **Real self-authored QR encoder** in `packages/core` (no third-party dep).
- **Immutable multi-clause waivers + check-in printout packet** and **snapshot-on-order** design (heard-about-us / merch names) so editing catalog never rewrites history.

---

## Phased build plan

### Phase 1 — generic must-haves that make us genuinely switch-worthy

- **Tiered cancellation policy + refund** — Data: `CancellationTier` (or JSON on Activity) `[{hoursBefore,refundPercent}]` + `cancellation_fee_cents` + `self_cancel_hours`. Endpoint: extend `cancelBooking(opts)` to compute `refundCents` by lead time and drive the Stripe partial-refund seam. UI: ReservationCard cancel panel previews refund before confirm; `/settings/policies` editor.
- **Self-service cancel** — Endpoint: `POST /:orderNumber/self-cancel` mirroring the self-reschedule email/magic-link gate, enforcing the Phase-1 policy. UI: replace the `manage-panel.tsx` mailto with a confirm dialog previewing the refund.
- **Cancellation email/SMS** — Data: `MessageTemplateKind.BOOKING_CANCELLED` + `BookingCancelled.tsx`. Endpoint: `sendBookingCancellation()` called fire-and-forget from `cancelBooking` post-commit (+ SMS twin). UI: none.
- **Finish open-duration rental-window booking** — Data: columns already exist (`Activity.rental_open/close_minute`, `ScheduleRule.open/close_minute`). Endpoint: availability path returning the open window + rate durations when `start_minutes` empty; booking path accepting `{date,startMinute,rateId}` → ResourceBooking `[start,start+dur)` validated against open..close + pool. UI: web time-picker within the window.
- **Wire AddOns into checkout** — Data: none. Endpoint: checkout page server-loads `offerAddOns`; `booking.ts` already consumes `resolveAddOnLines`. UI: import the built `AddOns.tsx` into CheckoutClient, lift selection into its price-breakdown state.

### Phase 2 — strong adds

- **Rate classes / participant types** — Data: `RateClass {rate_id,label,price_cents,min_qty,max_qty}` + `OrderItemGuest` lines. Endpoint: `POST /orders` accepts `participants:[{rateClassId,qty}]`; item total = sum, capacity = sum qty. UI: nested class editor in StepRates + per-class stepper at checkout.
- **Post-trip review-request email** — Data: `MessageTemplateKind.REVIEW_REQUEST` + `operator.review_url`. Endpoint: `selectDuePostTripOrderIds` (status COMPLETED, no REVIEW_SENT), stamp REVIEW_SENT like REMINDER_SENT; cron mirrors runAllDueReminders. UI: none.
- **Sell gift cards/certs online** — Data: none. Endpoint: `POST /api/public/gift-cards/purchase` → Stripe PaymentIntent → issueGiftCard + email code. UI: `apps/web/app/gift` amount+recipient form.
- **Cart-hold expiry** — Data: `CartHold {operator_id,timeslot_id,rate_id,quantity,expires_at,session_id}` + `Operator.cart_hold_minutes`. Endpoint: `POST /holds` at checkout start; availability subtracts un-expired holds; sweeper (SandboxClock pattern) releases; booking consumes/clears on commit. UI: countdown in CheckoutClient.
- **Merchandise retail price** — Data: `MerchandiseItem.price_cents` (+ optional tax_exempt). Endpoint: merchandise create/update/serialize. UI: POS defaults line price (overridable).
- **Refunds-by-reason report** — Data: none. Endpoint: `buildRefundsReport` over OrderEvent type=REFUND grouped by metadata.reason, full-vs-partial split. UI: RefundsReportView + 'refunds' tab.
- **Per-slot bulk check-in / no-show-all + message-all** — Data: none. Endpoint: `checkInSlotAction`/`markSlotNoShowAction` (updateMany + OrderEvents); `POST /api/timeslots/:id/broadcast {channel,body}`. UI: slot-header buttons + compose sheet.
- **Message THIS guest from the card** — Data: none. Endpoint: `POST /api/orders/:id/message {channel,body}` (shares backend with slot broadcast). UI: 'Message guest' button on ReservationCard.
- **Reusable charge-preset catalog** — Data: `ChargePreset {operator_id,category,label,default_amount_cents,unit_label?,taxable,is_active}`. Endpoint: CRUD + optional presetId on addOrderChargeAction. UI: settings/fees 'post-return charges' tab.

### Phase 3 — nice-to-have / finish

- **QR check-in scan** — wire `packages/core/src/qr.ts` into QrPlaceholder + confirmation email; `POST /api/checkin/scan {token}` verifies HMAC → existing check-in path; staff 'Scan' button.
- **Promo AUTO + PER_CUSTOMER enforcement** — `PromoRedemption {promo_id,customer_id,order_id}` ledger; auto-apply best active AUTO promo at checkout.
- **Tax as first-class flag** — `Fee.is_tax` boolean (drop name-regex) + `Customer.tax_exempt`.
- **Message templates: SMS channel + override wiring** — `MessageTemplate.channel` enum + sms_body_override; wire resolveTemplate into reminder/refund senders.
- **Customer questions: show_in_confirmation + per-rate scope + DATE/PHONE types.**
- **Per-slot manual close/edit** — `POST /timeslots/:id/close` + nullable Timeslot columns (engine already honors manual CANCELLED).
- **Staff notification prefs** — `StaffNotificationPref` so alerts aren't all-or-nothing.
- **Prepaid deposit liability report** · **Heard-about-us report** · **Per-slot print roster** · **Merch catalog admin page + stock-adjust audit** · **Finish serialized-unit branch (feat/vessel-scheduling).**

---

## Skip or defer (LSRA-specific / niche / over-engineered)

- Capacity-TYPE enum selector — presentation sugar over mechanics we already implement.
- Priority-booking smart funnel (orphan/starred times) — tour-operator yield optimization.
- Self-service cross-activity SWAP with reprice — resort feature; staff cancel+rebook covers it.
- Month manifest view · Saved views · Grouped-by-activity toggle — density/UX niceties; day/week + Gantt cover the work.
- Per-single-slot hide/call-to-book menu — fleet out-of-service + hide_price already cover it.
- Abandoned-cart REPORT — conflicts with the clean "abandoned = released" invariant (recovery email is the useful part, in Phase 2).
- Cash-drawer / register close-out — only if walk-up cash is a real channel for target customers.
- Gift card multi-location scoping — operator-wide is the right default.
- Pre-auth / manual-capture damage holds — heavy; deposit+balance covers most.
- Configurable refund-reason picklist · Per-segment discount engine (would be a 4th pricing path).
- Per-activity notification config · Multi-language templates · Marketing integrations (GA4/Mailchimp) · Square provider — all sales-driven or niche.
