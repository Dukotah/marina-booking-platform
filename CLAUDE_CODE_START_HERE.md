# CLAUDE CODE — START HERE

This is your briefing for the marina-booking-platform project.

---

## MISSION

Build a modern marina booking platform dramatically better than Singenuity.
First operator: Lake Sonoma Marina (Lake Sonoma, CA) — 19 activities, 551 booked slots.

Read PRODUCT_REQUIREMENTS.md for the complete specification.

---

## MONOREPO SETUP

```bash
npx create-turbo@latest marina-booking-platform
cd marina-booking-platform
pnpm add -D typescript @types/node prisma
mkdir -p apps/web apps/admin apps/api
mkdir -p packages/ui packages/database packages/types packages/emails
```

---

## DATABASE SCHEMA (Prisma)

File: packages/database/prisma/schema.prisma

```prisma
generator client {
  provider = "prisma-client-js"
}
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

model Operator {
  id                  String     @id @default(cuid())
  name_internal       String
  name_external       String
  location_code       String     @unique
  website             String?
  timezone            String     @default("America/Los_Angeles")
  country             String     @default("US")
  // Contact
  address             String?
  city                String?
  state               String?
  zip                 String?
  phone               String?
  support_email       String?
  // Branding
  logo_dark_url       String?
  logo_light_url      String?
  favicon_url         String?
  primary_color       String?    // hex e.g. "#0057A8"
  accent_color        String?
  custom_domain       String?    // e.g. "book.lakesonoma.com"
  // Config
  legal_adult_age     Int        @default(18)
  blackout_dates      DateTime[]
  created_at          DateTime   @default(now())
  updated_at          DateTime   @updatedAt
  // Relations
  activities          Activity[]
  customers           Customer[]
  orders              Order[]
  promo_codes         PromoCode[]
  merchandise         MerchandiseItem[]
  cancellation_policies CancellationPolicy[]
  tip_configs         TipConfig[]
  booking_policy      BookingPolicy?
  customer_questions  CustomerQuestion[]
  heard_about_options HeardAboutUsOption[]
  waivers             Waiver[]
  resources           Resource[]
  notifications       BookingNotification[]
}

model Activity {
  id                    String           @id @default(cuid())
  operator_id           String
  operator              Operator         @relation(fields: [operator_id], references: [id])
  name_internal         String
  name_external         String
  status                   String           @default("ACTIVE")
  category                 String           @default("OTHER")
  visible_online           Boolean          @default(true)
  visible_kiosk            Boolean          @default(true)
  visible_register         Boolean          @default(true)
  min_participants         Int              @default(1)
  max_participants         Int              @default(10)
  description_html         String?
  photo_urls               String[]
  color                    String           @default("blue")
  waiver_required          Boolean          @default(true)
  waiver_id                String?
  self_reschedule_hours    Int              @default(48)
  self_reschedule_enabled  Boolean          @default(true)
  cancellation_policy_id   String?          // overrides operator default if set
  sort_index               Int              @default(0)
  created_at               DateTime         @default(now())
  updated_at               DateTime         @updatedAt
  rates                    Rate[]
  timeslots                Timeslot[]
  schedule_templates       ScheduleTemplate[]
  fees                     Fee[]
  order_items              OrderItem[]
  tip_configs              TipConfig[]
  customer_questions       CustomerQuestion[]
  cancellation_policy      CancellationPolicy? @relation(fields: [cancellation_policy_id], references: [id])
}

model Rate {
  id               String      @id @default(cuid())
  activity_id      String
  activity         Activity    @relation(fields: [activity_id], references: [id])
  name_internal    String
  name_external    String
  price_cents      Int
  duration_minutes Int         @default(240)
  is_active        Boolean     @default(true)
  online_only      Boolean     @default(false)
  internal_only    Boolean     @default(false)
  is_from_price    Boolean     @default(false)
  sort_index       Int         @default(0)
  order_items      OrderItem[]
}

model ScheduleTemplate {
  id               String     @id @default(cuid())
  operator_id      String
  activity_id      String
  activity         Activity   @relation(fields: [activity_id], references: [id])
  name             String
  status           String     @default("DRAFT")   // DRAFT | ACTIVE | ARCHIVED
  date_from        DateTime
  date_to          DateTime
  days_of_week     Int[]                           // 0=Sun 1=Mon ... 6=Sat
  start_times      String[]                        // ["09:00", "13:00", "17:00"]
  duration_minutes Int        @default(240)
  capacity_total   Int
  cutoff_minutes   Int        @default(30)         // stop online booking N min before start
  is_overnight     Boolean    @default(false)
  blackout_dates   DateTime[]
  notes            String?
  published_at     DateTime?
  published_by     String?
  created_at       DateTime   @default(now())
  updated_at       DateTime   @updatedAt
  timeslots        Timeslot[]
  @@index([activity_id, status])
}

model Timeslot {
  id                   String           @id @default(cuid())
  activity_id          String
  activity             Activity         @relation(fields: [activity_id], references: [id])
  schedule_template_id String?
  schedule_template    ScheduleTemplate? @relation(fields: [schedule_template_id], references: [id])
  datetime             DateTime
  capacity_total       Int
  capacity_booked      Int              @default(0)
  is_overnight         Boolean          @default(false)
  status               String           @default("AVAILABLE")  // AVAILABLE | FILLING_UP | FULL | CANCELLED | BLOCKED
  cutoff_minutes       Int?                                     // overrides template if set individually
  created_at           DateTime         @default(now())
  order_items          OrderItem[]
  @@index([activity_id, datetime])
  @@index([schedule_template_id])
}

model Customer {
  id           String   @id @default(cuid())
  operator_id  String
  operator     Operator @relation(fields: [operator_id], references: [id])
  first_name   String
  last_name    String
  email        String
  phone        String?
  address      String?
  city         String?
  state        String?
  zip          String?
  tags         String[]
  notes        String?
  created_at   DateTime @default(now())
  updated_at   DateTime @updatedAt
  orders       Order[]
  @@unique([operator_id, email])
}

model Order {
  id                   String      @id @default(cuid())
  order_number         String      @unique
  operator_id          String
  operator             Operator    @relation(fields: [operator_id], references: [id])
  customer_id          String
  customer             Customer    @relation(fields: [customer_id], references: [id])
  status               String      @default("UPCOMING")
  created_by           String      @default("CUSTOMER")
  subtotal_cents       Int
  tax_cents            Int         @default(0)
  processing_fee_cents Int         @default(0)
  tip_cents            Int         @default(0)
  total_cents          Int
  amount_paid_cents    Int         @default(0)
  balance_due_cents    Int
  promo_code_id        String?
  heard_about_us       String?
  is_returning_guest   Boolean     @default(false)
  created_at           DateTime    @default(now())
  updated_at           DateTime    @updatedAt
  items                OrderItem[]
  payments             Payment[]
  notes                Note[]
  history              OrderEvent[]
}

model OrderItem {
  id               String    @id @default(cuid())
  order_id         String
  order            Order     @relation(fields: [order_id], references: [id])
  activity_id      String
  activity         Activity  @relation(fields: [activity_id], references: [id])
  rate_id          String
  rate             Rate      @relation(fields: [rate_id], references: [id])
  timeslot_id      String
  timeslot         Timeslot  @relation(fields: [timeslot_id], references: [id])
  quantity         Int       @default(1)
  unit_price_cents Int
  status           String    @default("UPCOMING")
  waiver_signed    Boolean   @default(false)
  waiver_signed_at DateTime?
  driver_name      String?
  license_number   String?
  license_state    String?
  date_of_birth    DateTime?
  address          String?
  city             String?
  state            String?
  zip              String?
  has_driven_boat  Boolean?
  created_at       DateTime  @default(now())
}

model Payment {
  id                       String   @id @default(cuid())
  order_id                 String
  order                    Order    @relation(fields: [order_id], references: [id])
  method                   String   @default("CARD")
  status                   String   @default("PAID")
  amount_cents             Int
  refunded_cents           Int      @default(0)
  card_last_four           String?
  card_brand               String?
  cardholder_name          String?
  processor                String   @default("SQUARE")
  processor_transaction_id String?
  is_manually_keyed        Boolean  @default(false)
  processed_at             DateTime @default(now())
}

model Fee {
  id                String    @id @default(cuid())
  operator_id       String?
  activity_id       String?
  activity          Activity? @relation(fields: [activity_id], references: [id])
  name              String
  type              String    @default("PERCENT")
  value             Float
  enabled           Boolean   @default(true)
  ignore_tax_exempt Boolean   @default(false)
}

model MerchandiseItem {
  id                String   @id @default(cuid())
  operator_id       String
  operator          Operator @relation(fields: [operator_id], references: [id])
  name              String
  category          String
  cost_cents        Int      @default(0)
  on_hand_qty       Int?
  reorder_alert_qty Int?
  is_active         Boolean  @default(true)
}

model PromoCode {
  id              String    @id @default(cuid())
  operator_id     String
  operator        Operator  @relation(fields: [operator_id], references: [id])
  code            String
  name            String
  type            String    @default("ONE_CODE")
  discount_type   String    @default("PERCENT")
  discount_value  Float
  is_active       Boolean   @default(true)
  valid_from      DateTime?
  valid_until     DateTime?
  max_redemptions Int?
  times_redeemed  Int       @default(0)
  activity_ids    String[]
  @@unique([operator_id, code])
}

model Note {
  id         String   @id @default(cuid())
  order_id   String
  order      Order    @relation(fields: [order_id], references: [id])
  content    String
  author     String
  created_at DateTime @default(now())
}

model OrderEvent {
  id          String   @id @default(cuid())
  order_id    String
  order       Order    @relation(fields: [order_id], references: [id])
  type        String
  description String
  actor       String?
  metadata    Json?
  created_at  DateTime @default(now())
}

// ─── CANCELLATION POLICY ─────────────────────────────────────────────────────
// Operators configure their own tiered policies. Activities can override the
// operator default via cancellation_policy_id.

model CancellationPolicy {
  id          String             @id @default(cuid())
  operator_id String
  operator    Operator           @relation(fields: [operator_id], references: [id])
  name        String             // e.g. "Standard Marina Policy"
  is_default  Boolean            @default(false)
  created_at  DateTime           @default(now())
  updated_at  DateTime           @updatedAt
  tiers       CancellationTier[]
  activities  Activity[]
  @@index([operator_id])
}

model CancellationTier {
  id                     String             @id @default(cuid())
  cancellation_policy_id String
  policy                 CancellationPolicy @relation(fields: [cancellation_policy_id], references: [id])
  hours_before           Int                // applies when cancelling within this many hours of start
  fee_type               String             @default("PERCENT") // PERCENT | FLAT | NONE
  fee_value              Float              // 50 = 50%, or cents for FLAT
  label                  String?            // "50% fee — cancels within 7 days"
  sort_index             Int                @default(0)
}

// ─── TIP CONFIGURATION ───────────────────────────────────────────────────────
// Operators define tip options per activity or globally. Multiple active configs
// per activity are shown as a selector at checkout.

model TipConfig {
  id          String    @id @default(cuid())
  operator_id String
  operator    Operator  @relation(fields: [operator_id], references: [id])
  activity_id String?   // null = applies to all activities for this operator
  activity    Activity? @relation(fields: [activity_id], references: [id])
  label       String    // "20% Gratuity"
  type        String    @default("PERCENT") // PERCENT | FLAT
  value       Float     // 20.0 for 20%, or cents for FLAT
  is_default  Boolean   @default(false)
  sort_index  Int       @default(0)
  is_active   Boolean   @default(true)
}

// ─── BOOKING POLICY ──────────────────────────────────────────────────────────
// One per operator. Controls global booking rules shown to customers at checkout
// and enforced at check-in.

model BookingPolicy {
  id                       String   @id @default(cuid())
  operator_id              String   @unique
  operator                 Operator @relation(fields: [operator_id], references: [id])
  checkin_window_minutes   Int      @default(30)   // arrive X min before start
  min_operator_age         Int      @default(21)   // min age to operate a motorized vessel
  require_photo_id         Boolean  @default(true)
  parking_included         Boolean  @default(true)
  parking_notes            String?
  fuel_policy              String?  // "Fuel charged at end of visit based on usage"
  max_advance_booking_days Int      @default(365)  // how far ahead customers can book online
  min_advance_booking_hours Int     @default(2)    // min lead time before start (global fallback)
  allow_same_day_booking   Boolean  @default(true)
  terms_html               String?  // operator-authored terms displayed at checkout
  updated_at               DateTime @updatedAt
}

// ─── CUSTOMER QUESTIONS ──────────────────────────────────────────────────────
// Custom questions shown during checkout. Can be global or per-activity.

model CustomerQuestion {
  id          String    @id @default(cuid())
  operator_id String
  operator    Operator  @relation(fields: [operator_id], references: [id])
  activity_id String?   // null = shown for all activities
  activity    Activity? @relation(fields: [activity_id], references: [id])
  question    String
  field_type  String    @default("TEXT") // TEXT | SELECT | CHECKBOX | NUMBER | DATE
  options     String[]  // for SELECT type
  is_required Boolean   @default(false)
  sort_index  Int       @default(0)
  is_active   Boolean   @default(true)
}

// ─── HEARD ABOUT US ──────────────────────────────────────────────────────────

model HeardAboutUsOption {
  id          String   @id @default(cuid())
  operator_id String
  operator    Operator @relation(fields: [operator_id], references: [id])
  label       String   // "Google", "Instagram", "Friend / Family", "Return Guest"
  sort_index  Int      @default(0)
  is_active   Boolean  @default(true)
}

// ─── WAIVERS ─────────────────────────────────────────────────────────────────

model Waiver {
  id                      String           @id @default(cuid())
  operator_id             String
  operator                Operator         @relation(fields: [operator_id], references: [id])
  name                    String
  body_html               String           // full waiver text (rich text / HTML)
  requires_minor_guardian Boolean          @default(true)
  is_active               Boolean          @default(true)
  created_at              DateTime         @default(now())
  updated_at              DateTime         @updatedAt
  signatures              WaiverSignature[]
}

model WaiverSignature {
  id              String   @id @default(cuid())
  waiver_id       String
  waiver          Waiver   @relation(fields: [waiver_id], references: [id])
  order_item_id   String
  customer_id     String?
  signed_at       DateTime @default(now())
  signature_data  String   // base64 drawn signature or typed name
  ip_address      String?
  user_agent      String?
  is_minor        Boolean  @default(false)
  guardian_name   String?
  @@index([order_item_id])
}

// ─── RESOURCES ───────────────────────────────────────────────────────────────
// Physical assets (individual boats, jet skis, kayaks). Linked to activities
// for capacity enforcement and maintenance scheduling.

model Resource {
  id                   String   @id @default(cuid())
  operator_id          String
  operator             Operator @relation(fields: [operator_id], references: [id])
  name                 String   // "Pontoon #3 — Blue Wave"
  category             String   // BOAT | WATERCRAFT | EQUIPMENT | OTHER
  seat_capacity        Int      @default(1)
  assigned_activity_ids String[]
  serial_number        String?
  year                 Int?
  make                 String?
  model                String?
  status               String   @default("ACTIVE") // ACTIVE | OUT_OF_SERVICE | RETIRED
  out_of_service_reason String?
  last_serviced_at     DateTime?
  notes                String?
  created_at           DateTime @default(now())
  updated_at           DateTime @updatedAt
}

// ─── BOOKING NOTIFICATIONS ───────────────────────────────────────────────────
// Operators configure who gets notified and for which activities.

model BookingNotification {
  id              String   @id @default(cuid())
  operator_id     String
  operator        Operator @relation(fields: [operator_id], references: [id])
  channel         String   @default("EMAIL") // EMAIL | SMS
  recipient       String   // email address or phone number
  activity_ids    String[] // empty array = all activities
  triggers        String[] // NEW_BOOKING | CANCELLATION | RESCHEDULE | REMINDER | REFUND
  is_active       Boolean  @default(true)
  created_at      DateTime @default(now())
}
```

---

## LAKE SONOMA MARINA SEED DATA

### 19 Activities

| Name | Category | Max Cap | From Price |
|---|---|---|---|
| 5 Person Pontoon Boat Rental | BOAT | 5 | $350/Half Day |
| 10 Person Pontoon Rental | BOAT | 10 | $420/Half Day |
| 12 Person Pontoon Boat Rental | BOAT | 12 | $520/Half Day |
| Double Decker Pontoon Rental | BOAT | 12 | $585/Half Day |
| Premium 10P Single Story Pontoon | BOAT | 10 | $600/Half Day |
| Watersport/Tubing Boat (7P) | BOAT | 7 | $600/Half Day |
| Premium Sport Boat (8P) | BOAT | 8 | $700/Half Day |
| Jet Ski Rentals (2P) | WATERCRAFT | 2 | $150/Hour |
| Single Kayak Rental | WATERCRAFT | 1 | $50/Hour |
| Double Kayak Rental | WATERCRAFT | 2 | $50/Hour |
| Paddle Board Rental | WATERCRAFT | 1 | $50/Hour |
| Canoe Rental (2P) | WATERCRAFT | 2 | $50/Hour |
| Grand Patio | PATIO | 100 | TBD/Day |
| Bar Patio | PATIO | 50 | $100/Day |
| Scenic Patio | PATIO | 50 | $100/Day |
| Bridge Patio | PATIO | 20 | $100/Day |
| Lakeside Patio 5 | PATIO | 20 | $100/Day |
| Lakeside Patio 6 | PATIO | 20 | $100/Day |
| Upper Lakeside Patio 7 | PATIO | 20 | $100/Day |

### Rates (5-Person Pontoon — scale for other boats)
- One Hour: $125 (internal only)
- Two Hour: $250
- Half Day (4hr): $350 (is_from_price: true)
- Full Day (8hr): $625
- Overnight: $1,000

### Fees
- Sales Tax: 9.25%
- Processing Fee: 4.00%

### Booking Policies
- Cancellation < 7 days: 50% fee
- Cancellation < 24 hours: 100% fee
- Operator cancellation (weather): full refund
- Check-in: 30 min before booking
- Parking: 1 vehicle included
- Fuel: paid at end of visit
- Min boat operator age: 21 years
- Valid government photo ID required

### Tips (pre-configured)
- 15% Gratuity
- 20% Gratuity (default)
- 25% Gratuity

### Staff Notification
- Email: Staff@lakesonoma.com (all 19 activities)

---

## TECH STACK

| Layer | Technology |
|---|---|
| Monorepo | Turborepo + pnpm |
| Customer Portal | Next.js 14 App Router |
| Admin Dashboard | Next.js 14 App Router |
| API | Bun + Hono (or Node.js + Fastify) |
| Database | PostgreSQL + Prisma |
| Cache | Redis |
| Jobs | BullMQ |
| Payments | Square SDK |
| Email | Resend + React Email |
| SMS | Twilio |
| Auth | Clerk (operators), Magic Link (customers) |
| Storage | Cloudflare R2 |
| Deploy | Vercel + Railway |
| UI | Tailwind CSS + shadcn/ui |

---

## BUILD ORDER (Phase 1 MVP)

1. Monorepo scaffold + Prisma schema
2. Database migrations + seed
3. API: auth, activities, rates, timeslots
4. Admin: operator setup wizard
5. Customer portal: catalog → date → time → rate
6. API: orders + payment (Square)
7. Email: confirmation + reminder (Resend)
8. Admin: day Gantt manifest
9. Admin: order list + detail + refund
10. Waiver: digital signing flow

---

## KEY UX REQUIREMENTS

### Customer Portal
- Activity catalog: photo cards, search bar, category filter, capacity filter
- Availability calendar: color-coded (green=available, yellow=filling, red=full)
- Time slots: cards with "X spots left" indicator (not a plain list)
- Checkout: single page with participant info + waiver + payment
- Mobile-first, white-label (no platform branding)

### Admin Dashboard
- HOME: KPI cards (revenue today/week/month, occupancy %), alerts, upcoming bookings
- MANIFEST: Gantt chart (Y=activities, X=time, blocks=bookings, drag to reschedule)
- ORDERS: filterable list + detail with full timeline
- ACTIVITIES: simplified wizard (not 10 separate tabs)
- POS: integrated (not a separate app/login)

---

*Auto-generated from live Singenuity analysis — June 3, 2026*
