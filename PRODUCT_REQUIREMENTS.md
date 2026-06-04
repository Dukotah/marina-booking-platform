# Marina Booking Platform — Product Requirements Document

> **Mission:** Build a modern, beautiful, blazing-fast booking platform for marinas and outdoor recreation operators that destroys the clunky experience of legacy tools like Singenuity.

---

## Repository: https://github.com/Dukotah/marina-booking-platform

---

## 1. What Singenuity Gets Wrong (From Live Analysis)

### 1.1 Admin Dashboard (manage.singenuity.com)

**Products nav:** Activities, Packages, Gift Certs, Gift Cards, Merchandise, Rentals, Resources, Memberships

**Settings nav (18+ pages):** General, Payments & Refunds, Integrations, Booking Settings, Taxes & Fees, Emails, Waiver, Discounts, Promo Codes, Affiliates, Users & Permissions, Heard About Us, Transportation, Message Templates, Booking Notifications, Customer Questions, General Ledger, Guide Roles

**Reports nav:** Sales, Taxes & Fees, Tips, Merchandise, Packages, Payments, Insights, Gift Cards, Memberships, Gift Certificates

**OBSERVED BUGS & PAIN POINTS:**
- Reports section returns 404 on most sub-pages (broken routing)
- 18+ settings pages with no search or global save — settings sprawl
- Activity config has 10+ sub-tabs (Configuration, Rates, Messages, Schedules, Schedule Templates, Fees, Emails & Texts, Photos, Tips, Self-Reschedule, Package Upsells)
- Packages shows empty but upsell config references packages — circular dependency
- Resources not used despite 19 active activities
- Memberships page returns 404
- Rentals enabled but empty
- No dashboard home — lands on raw manifest
- No customer CRM module visible
- Register is a SEPARATE APP at register.singenuity.com (separate login)
- Day manifest shows 3/551 booked (1%) — no visual heatmap
- Week view is a flat horizontal date strip, not a real calendar grid

### 1.2 Customer Booking Flow (book.singenuity.com/758)

**Observed steps:**
1. Catalog grid (19 activities, photo cards, no filter/search)
2. Click activity → detail page + inline calendar date picker
3. Pick date → time slot list (9:00AM–3:00PM, 30-min intervals, plain list)
4. Pick time → rate picker (Half Day $350 / Full Day $625 with +/- qty)
5. Checkout → (payment)

**Pain Points:**
- No search or filter on catalog
- No map showing marina location
- Calendar shows all dates clickable — no availability preview
- Time slots: plain list, no capacity indicators
- "Overnight Bookings" label appears with no explanation
- No upsells during checkout
- "Powered by Singenuity" branding visible to customers
- No reviews or social proof
- No customer accounts — anonymous booking only

### 1.3 Register App (register.singenuity.com)

**Tabs:** Bookings (Day/Week), Waivers, Sell (POS), Orders, Search

**Pain Points:**
- Text-heavy manifest, no Gantt view, no color coding
- PII exposed inline on shared screens (license#, DOB, address)
- No drag-to-reschedule
- No quick check-in button
- Completely separate from admin app

---

## 2. Data Models

### Operator
```
id, name_internal, name_external, location_code (e.g. "LSRA"),
website, address, phone, timezone, country, logo_dark, logo_light,
legal_adult_age, enable_pre_authorizations, blackout_days[]
```

### Activity
```
id, operator_id, name_internal, name_external,
status: active|inactive, visible_online, visible_kiosk, visible_register,
category: boat|watercraft|patio|tour|other,
min_participants, max_participants, description_html, photo_urls[],
color, from_price_cents, waiver_required, enable_guide_scheduling,
self_reschedule_enabled, sort_index,
rates[], fees[], tip_config, messages
```

### Rate
```
id, activity_id, name_internal, name_external,
price_cents, duration_minutes, is_active,
online_only, internal_only, is_from_price, sort_index
```

**Real rates (5-Person Pontoon):**
- 1hr: $125 (internal only)
- 2hr: $250
- Half Day 4hr: $350
- Full Day 8hr: $625
- Overnight: $1,000

### Timeslot
```
id, activity_id, datetime, capacity_total, capacity_booked,
capacity_available, is_overnight,
status: available|filling_up|full|cancelled
```

### Order
```
id, order_number (e.g. LSRA01260603041),
operator_id, customer_id, status: upcoming|completed|cancelled|no_show,
created_by: customer|staff|kiosk, subtotal_cents, tax_cents,
processing_fee_cents, tip_cents, total_cents, amount_paid_cents,
balance_due_cents, promo_code_id, heard_about_us, is_returning_guest
```

### OrderItem
```
id, order_id, activity_id, rate_id, timeslot_id, quantity,
unit_price_cents, status, waiver_signed, waiver_signed_at,
participant_info: { driver_name, license_number, license_state,
  date_of_birth, address, city, state, zip, has_driven_boat_before }
```

### Customer
```
id, operator_id, first_name, last_name, email, phone,
address, city, state, zip, tags[], lifetime_value_cents,
total_bookings, last_booking_at, saved_payment_methods[],
waiver_on_file, notes
```

### Payment
```
id, order_id, method: card|cash|gift_card|comp,
status: paid|refunded|partial_refund|failed|pre_authorized,
amount_cents, refunded_cents, card_last_four, card_brand,
processor: square|stripe, processor_transaction_id,
is_manually_keyed, processed_at
```

### Fee
```
id, activity_id (null=global), name, type: percent|flat, value,
enabled, ignore_for_tax_exempt
```
**Lake Sonoma:** Sales Tax 9.25%, Processing Fee 4.00%

### MerchandiseItem
```
id, operator_id, name, category, cost_cents,
on_hand_qty, reorder_alert_qty, is_active
```
**Categories:** Add-Ons, Damages & Safety Equipment, Dock, Fuel
**Items (16):** Cleaning fee, Overloading fee, Propellers, PFC Vest, Late Fee, Pump-out, Slipholder Gas, LSRA Gas, Rental Gas, General Gas, + 6 more

### PromoCode
```
id, operator_id, code, name, type: one_code|per_customer|auto,
discount_type: percent|flat, discount_value, is_active,
valid_from, valid_until, max_redemptions, times_redeemed
```
**Example:** LASTSPLASH (Sept-Oct 2025)

### Waiver / WaiverSignature
```
Waiver: id, operator_id, template_html, requires_minor_signature
WaiverSignature: id, waiver_id, order_item_id, customer_id,
  signed_at, signature_data, ip_address, is_minor, guardian_name
```

### Resource (Physical Asset)
```
id, operator_id, name, seat_capacity_per_unit, quantity,
out_of_service_count, assigned_activity_ids[], enable_timer
```

### BookingNotification
```
id, operator_id, type: email|text, recipient,
applicable_activity_ids[], triggers: new_booking|cancellation|reschedule|reminder
```
**Configured:** staff@lakesonoma.com → all 19 activities

### Integrations
```
google_analytics_4_id, facebook_pixel_id, google_ads_conversion_id,
microsoft_ads_conversion_id, mailchimp_api_key, mailchimp_audience_id,
podium_api_key, square_merchant_id, square_location_id,
twilio_phone_number, google_calendar_enabled, sojern_pixels,
localize_js_key
```

---

## 3. Feature Requirements

### 3.1 Customer Booking Portal

**Must Have:**
- Activity catalog with search + filter (category, capacity, price, date)
- Map embed (Google Maps) showing marina location
- Visual availability calendar (green/yellow/red by availability)
- Time slot cards with capacity shown ("3 of 5 spots left")
- Rate comparison (duration + price side by side)
- Participant info collection (license, DOB, experience)
- Digital waiver signing inline at checkout
- Promo code field
- Price breakdown (subtotal + tax + fee + tip)
- Square payments (card + Apple Pay + Google Pay)
- Booking confirmation + email with QR code
- Mobile-first responsive design
- Full white-label (zero platform branding)

**Should Have:**
- Customer accounts (optional, save info + view history)
- Add-on upsells inline (fuel, safety gear, photos)
- Package bundle suggestions
- Self-service reschedule and cancellation
- Browse by date (pick date, see all available activities)
- Activity photo gallery

**Nice to Have:**
- Reviews and ratings per activity
- Activity comparison side-by-side
- Membership purchase + management

### 3.2 Operator Admin Dashboard

**Must Have:**
- Dashboard home: revenue KPIs (today/week/month), occupancy %, upcoming bookings feed, alerts
- Day manifest: Gantt-style visual timeline, color-coded by activity type
- Week manifest: proper grid calendar (not a flat date strip)
- Activity wizard (4-step: info → rates → schedule → preview)
- Rate CRUD
- Schedule builder with recurring patterns + blackout dates
- Order list with search/filter
- Order detail with full timeline + one-click actions
- Inline refund (partial or full with reason code)
- Walk-up booking creation from manifest
- Waiver status tracking + signing flow
- Email resend / send to customer

**Should Have:**
- Drag-to-reschedule on manifest
- Customer CRM profiles (LTV, history, tags)
- Merchandise POS (integrated — same app, same login)
- Revenue + occupancy + tax reports with CSV export
- Booking notifications (email + SMS) config
- Staff roles (Admin, Manager, Staff, Guide)
- Resource management (link physical boats/assets to activities)

**Nice to Have:**
- Dynamic pricing (surge by date/demand)
- Guide scheduling + guide-facing app view
- Affiliate / channel management
- Package builder
- Kiosk mode (tablet self-serve)
- Multi-location dashboard
- QuickBooks / Xero export

### 3.3 POS / Register (INTEGRATED — NOT a separate app)
- Activity booking creation for walk-ups
- Merchandise sale
- Gift card sale + redemption
- Square terminal integration
- Cash handling (drawer + cash counted)
- QR code scanner (check-in + product lookup)
- Receipt printing
- Offline mode (queue transactions when offline)

---

## 4. Design Principles

| What Singenuity Does | What We Do Instead |
|---|---|
| 2 separate apps, 2 logins | One app, one login (role-filtered views) |
| 18+ settings pages, no search | Guided wizard setup, grouped settings |
| No dashboard, dumps to manifest | Dashboard-first with KPIs |
| Broken 404 pages everywhere | Zero broken pages, tested routing |
| Text-wall manifest | Visual Gantt with color + capacity bars |
| Empty features (packages, resources) | All features work on day 1 with onboarding |
| "Powered by Singenuity" on customer pages | Full white-label |
| No availability signal on catalog | Color-coded availability dots per activity |

---

## 5. Technical Architecture

### Stack
- **Frontend:** Next.js 14+ (App Router), TypeScript, Tailwind CSS, shadcn/ui, Framer Motion, TanStack Query, Zustand
- **Backend:** Bun + Hono (or Node.js + Fastify), PostgreSQL, Prisma ORM, Redis, BullMQ
- **Payments:** Square SDK (primary), Stripe (optional)
- **Infrastructure:** Vercel (frontend), Railway/Render (API), Cloudflare R2 (assets), Resend (email), Twilio (SMS)
- **Auth:** Clerk or Auth0 (operators), magic link (customers)

### Monorepo Structure
```
marina-booking-platform/
├── apps/
│   ├── web/        # Customer booking portal
│   ├── admin/      # Operator dashboard + POS
│   └── api/        # REST API + WebSocket
├── packages/
│   ├── ui/         # Shared component library
│   ├── database/   # Prisma schema + migrations
│   ├── types/      # Shared TypeScript interfaces
│   ├── utils/      # Helpers and validators
│   └── emails/     # React Email templates
├── docs/           # This folder
├── turbo.json
└── package.json
```

### Multi-tenant Design
- All tables include `operator_id`
- Row-level security in PostgreSQL
- Operator subdomains: `{slug}.platform.com` or custom domains
- Shared infrastructure, isolated data

---

## 6. Implementation Phases

### Phase 1 — MVP (Weeks 1-8)
1. Monorepo setup (Turborepo + Next.js + Hono + Prisma + PostgreSQL)
2. Operator auth (Clerk) + customer magic link
3. Operator onboarding wizard (4 steps)
4. Activity CRUD (simplified wizard)
5. Customer booking portal: catalog → date → time → rate → checkout
6. Square payment processing
7. Email confirmations (Resend + React Email)
8. Order list + detail + cancel + refund
9. Day Gantt manifest view
10. Digital waiver signing

### Phase 2 — Core Operations (Weeks 9-16)
11. Merchandise POS (same app)
12. Gift cards
13. Promo codes + discounts
14. Customer CRM
15. Revenue + occupancy + tax reports
16. Staff roles + permissions
17. SMS notifications (Twilio)
18. Self-service reschedule for customers

### Phase 3 — Power Features (Weeks 17-24)
19. Resource management (boats as assets)
20. Guide scheduling
21. Package builder + upsells
22. Affiliate management
23. Dynamic pricing
24. Kiosk mode
25. Multi-location
26. Accounting exports

---

## 7. Lake Sonoma Marina Seed Data

### 19 Active Activities
| Activity | Capacity | From Price |
|---|---|---|
| 5 Person Pontoon Boat Rental | 5 | $350/Half Day |
| 10 Person Pontoon Rental | 10 | $420/Half Day |
| 12 Person Pontoon Boat Rental | 12 | $520/Half Day |
| Double Decker Pontoon Rental | 12 | $585/Half Day |
| Premium 10P Single Story Pontoon | 10 | $600/Half Day |
| Watersport/Tubing Boat (7P) | 7 | $600/Half Day |
| Premium Sport Boat (8P) | 8 | $700/Half Day |
| Jet Ski Rentals (2P) | 2 | $150/Hour |
| Single Kayak Rental | 1 | $50/Hour |
| Double Kayak Rental | 2 | $50/Hour |
| Paddle Board Rental | 1 | $50/Hour |
| Canoe Rental (2P) | 2 | $50/Hour |
| Grand Patio | 100 | TBD/Day |
| Bar Patio | 50 | $100/Day |
| Scenic Patio | 50 | $100/Day |
| Bridge Patio | 20 | $100/Day |
| Lakeside Patio 5 | 20 | $100/Day |
| Lakeside Patio 6 | 20 | $100/Day |
| Upper Lakeside Patio 7 | 20 | $100/Day |

### Fees
- Sales Tax: 9.25%
- Processing Fee: 4.00%

### Booking Policies
- Cancellation < 7 days: 50% fee
- Cancellation < 24 hours: 100% fee
- Operator cancellation (weather): full refund
PRODUCT_REQUIREMENTS.md- Parking: 1 vehicle included
- Fuel: paid at end of visit
- Minimum boat operator age: 21
- Valid photo ID required

### Tips
- Option 1: 15% Gratuity
- Option 2: 20% Gratuity
- Option 3: 25% Gratuity

---

## 8. Success Metrics

| Metric | Target |
|---|---|
| Booking conversion rate | >8% |
| Mobile booking rate | >60% |
| Page LCP | <1.5s |
| Admin task time vs Singenuity | 50% faster |
| Operator onboarding time | <2 hours |
| Waiver pre-completion rate | >95% |
| Broken page rate | 0% |

---

*Analysis date: June 3, 2026*
*Source: register.singenuity.com + manage.singenuity.com + book.singenuity.com/758 (Lake Sonoma Marina)*

---

## 9. Architecture Decisions Log

> Decisions locked before scaffolding. Update this section as remaining decisions are resolved.

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | API runtime + framework | **Bun + Hono** | Faster than Node + Fastify, open source, great Prisma support, zero cost |
| 2 | Operator auth | **Clerk** | Free up to 10k MAU, best Next.js App Router DX, prebuilt UI components |
| 3 | Timeslot generation | **ScheduleTemplate model + draft/publish workflow** | FareHarbor-style bulk generation (date range × days of week × start times) with Singenuity-style named reusable templates. Agent layer drives the same flow via natural language. |
| 4 | Double-booking prevention | **Optimistic concurrency (Postgres-only)** | Atomic `UPDATE ... WHERE capacity_booked + qty <= capacity_total`. No Redis, no TimeslotHold model, no extra infrastructure. If 0 rows affected, spot was taken — show error. Free and simple. |
| 5 | Cancellation policy | **CancellationPolicy + CancellationTier DB models** | Full operator customization. Tiered rules (hours_before + fee_type + fee_value). Operators create named policies; activities can override the operator default. No hardcoding. |

### Hosting Stack (Free Until Revenue)

| Layer | Service | Free Tier |
|---|---|---|
| Frontend (web + admin) | Vercel | Hobby — free |
| API | Railway | $5/month credit — free at zero traffic |
| Database | Neon (PostgreSQL) | 0.5 GB, 1 project — free |
| Auth | Clerk | 10,000 MAU — free |
| Email | Resend | 3,000 emails/month — free |
| Storage | Cloudflare R2 | 10 GB/month — free |
| Payments | Square | No monthly fee — percentage only |
| Redis / queue | Skip for MVP | Postgres-based polling instead |
| SMS | Skip for MVP | Email only until revenue |

**Monthly cost at zero users: $0.** Square only charges when an operator processes a booking.

### ScheduleTemplate Workflow (FareHarbor-inspired)
1. Operator creates a named template with date range, days of week, start times, capacity, cutoff — saves as `DRAFT`
2. System previews the exact slots it would generate (calendar view, count of slots) before anything goes live
3. Operator hits **Publish** → status becomes `ACTIVE`, system bulk-generates `Timeslot` rows linked back to the template
4. Template stays saved as a named, reusable object — duplicate for next season, tweak dates, republish
5. Individual timeslots can override template defaults (e.g., bump capacity on a holiday, block a specific day)
6. Schedule agent can drive this entire flow via natural language

---

## 10. Competitive Feature Backlog

> Research date: June 4, 2026. Sources: FareHarbor, Peek Pro, Dockwa, RentalTide, Checkfront, Rezdy/Regiondo, Singenuity live audit. These features are **NOT in the MVP** but are logged here so nothing gets lost.

---

### 10.1 Competitor Landscape Summary

| Platform | Strength | Key Weakness |
|---|---|---|
| FareHarbor (Booking Holdings) | 250+ OTA connections, abandoned cart (20% conversion), waitlist | 6% booking fee, 14s checkout lag, waivers are third-party, not marine-specific |
| Peek Pro | AI dynamic pricing, smart upsells (16% lost-sale recovery), review automation | 6-8% fee, no marine features |
| Dockwa | Purpose-built marina (fuel, slips, contracts), smart waitlist, unified revenue view | Not activity/rental UX focused, no OTA distribution |
| RentalTide | GPS fleet tracking, damage deposit holds, fuel tracking, AI pricing, zero monthly fee | Newer, less proven at scale |
| Singenuity | All-in-one claim, low processing fees, owned data | 2 separate apps, no dashboard, broken reports, anonymous booking only |

---

### 10.2 Features Missing from Singenuity That Competitors Have

These are confirmed gaps in Singenuity that we will build — phased by priority.

#### Revenue & Conversion (High ROI — build when ready)
- **Abandoned cart recovery** — Email triggered when checkout is abandoned mid-flow. FareHarbor achieves 20% conversion; Peek Pro reports 10.2% average revenue increase. Collect email at step 1 of checkout, fire recovery email after 30 min inactivity.
- **Waitlist** — Customer queues for a fully-booked timeslot. When a cancellation opens a spot, auto-notify waitlisted guests with one-click booking link. Dockwa calls this "smart waitlist."
- **Smart upsells / add-ons at checkout** — Optional add-ons presented after rate selection (life vests, GoPro rental, fuel pre-pay, trip insurance). Peek Pro recaptures 16% of otherwise-lost sales via this flow.
- **Split payment / group payment links** — Allow a group to divide the cost; primary booker sends a link to each participant to pay their share.
- **Deposit now / balance later** — Customer pays a set amount (e.g., 50%) at booking, remainder is billed automatically X days before the trip.
- **AI / demand-based dynamic pricing** — Adjust rates based on remaining capacity, season, day of week, or weather forecast. Peek Pro and Dockwa both offer this.

#### Booking Flow (Customer-Facing)
- **Real customer accounts** — Returning customers log in, see booking history, saved payment, saved participant info. Most platforms (including Singenuity) are anonymous-only.
- **Post-experience review requests** — Automated email X hours after rental return, requesting a review. Peek Pro ties this to specific activities.
- **Group / private charter booking** — Dedicated flow for private buyout of an activity. Different pricing, min/max rules, custom confirmation.
- **Browse by date** — Pick a date first, see all available activities that day (inverse of current catalog-first flow).

#### Operations (Admin / Staff)
- **Damage pre-authorization hold** — Pre-auth a card for a damage deposit at check-in without charging it. Square supports this natively. Release automatically at return, or charge if damage reported.
- **Fuel charges billed at end of rental** — Staff enters fuel consumed at return; system calculates charge and bills the card on file. Critical for Lake Sonoma ("Fuel: paid at end of visit").
- **Overtime / late return charge** — Alert and auto-charge if rental runs past scheduled end time.
- **Before/after damage inspection with photos** — Staff uploads photos at check-out and check-in; stored against the order.
- **Weather cancellation flow** — Bulk-cancel timeslots with one action; auto-issue full refunds or store credit; notify all affected customers via email/SMS.
- **Custom saved manifest views** — Staff can save filtered manifest views (e.g., "Jet Skis only", "My assigned activities"). FareHarbor calls these "custom manifests."
- **Offline QR check-in** — Mobile app can scan QR codes and check guests in without an internet connection, syncing when back online.

#### Distribution & Growth
- **OTA / channel distribution** — List activities on Viator, GetYourGuide, Airbnb Experiences with live inventory sync. FareHarbor's FHDN connects to 250+ OTAs.
- **Affiliate & partner management** — Allow referral partners to embed a booking widget and earn commissions. Time-windowed access rules.

#### Marine-Specific (Differentiated)
- **GPS fleet tracking hooks** — Integration point for GPS providers (e.g., Docklyne). Surface current boat location on manifest. Geofence alerts if a vessel leaves approved waters.
- **Engine hour / fuel gauge monitoring** — Pull data from GPS/IoT sensors for maintenance scheduling and billing.

---

### 10.3 New Data Models to Add Before Scaffolding

These models were identified during competitive research. None are in the current Prisma schema.

```
WaitlistEntry
  id, timeslot_id, customer_id, operator_id,
  status: WAITING | NOTIFIED | CONVERTED | EXPIRED,
  notified_at, expires_at, created_at

AbandonedCart
  id, operator_id, session_id, email?,
  items_json (snapshot of cart state),
  recovery_sent_at, recovered_at, expires_at, created_at

PreAuthorization
  id, order_id, order_item_id,
  amount_cents, card_last_four, card_brand,
  processor_auth_id, status: HELD | RELEASED | CAPTURED,
  held_at, released_at, captured_at

FuelCharge
  id, order_id, order_item_id,
  gallons_decimal, unit_price_cents, total_cents,
  charged_at, charged_by (staff actor)

AddOn
  id, operator_id, activity_ids[] (empty = all activities),
  name, description, price_cents, is_active,
  requires_quantity (bool), max_quantity, sort_index

OrderItemAddOn
  id, order_item_id, add_on_id,
  quantity, unit_price_cents

DamageReport
  id, order_id, order_item_id,
  description, charge_cents,
  photo_urls[], reported_by, reported_at,
  status: OPEN | CHARGED | WAIVED

Review
  id, operator_id, activity_id, order_id, customer_id,
  rating (1-5), body, is_public, is_verified,
  created_at, published_at

ReviewRequest
  id, order_id, customer_id,
  scheduled_for, sent_at, completed_at, status

ChannelListing
  id, operator_id, activity_id,
  channel: VIATOR | GETYOURGUIDE | AIRBNB | CUSTOM,
  external_product_id, commission_pct, is_active

AffiliatePartner
  id, operator_id, name, slug, commission_pct,
  booking_window_start, booking_window_end, is_active
```

---

### 10.4 Our Differentiators (Features Nobody Does Well)

These are confirmed gaps across ALL competitors — genuine opportunities:

| Differentiator | Why Nobody Has Done It Well |
|---|---|
| One app, one login (admin + register + POS) | Everyone splits it: FareHarbor dashboard ≠ mobile manifest; Singenuity is literally 2 separate apps |
| Visual Gantt manifest + drag-to-reschedule | All competitors use text lists or flat date strips |
| Inline waiver signing at checkout (no redirect) | FareHarbor outsources to Smartwaiver/Wherewolf (redirect to third-party app) |
| Real customer accounts with history + self-reschedule | Most platforms, including Singenuity, are anonymous-only |
| Full white-label (zero platform branding) | FareHarbor, Peek Pro, and Singenuity all show platform branding on customer pages |
| Guided operator onboarding wizard | Nobody does this; operators drown in 18+ settings pages |
| Integrated review collection tied to specific activity | Peek Pro does post-experience emails but generically; tying to the exact boat/activity is better |
