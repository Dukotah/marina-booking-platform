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
  id               String     @id @default(cuid())
  name_internal    String
  name_external    String
  location_code    String     @unique
  website          String?
  timezone         String     @default("America/Los_Angeles")
  country          String     @default("US")
  logo_dark_url    String?
  logo_light_url   String?
  legal_adult_age  Int        @default(18)
  created_at       DateTime   @default(now())
  activities       Activity[]
  customers        Customer[]
  orders           Order[]
  promo_codes      PromoCode[]
  merchandise      MerchandiseItem[]
}

model Activity {
  id                    String           @id @default(cuid())
  operator_id           String
  operator              Operator         @relation(fields: [operator_id], references: [id])
  name_internal         String
  name_external         String
  status                String           @default("ACTIVE")
  category              String           @default("OTHER")
  visible_online        Boolean          @default(true)
  min_participants      Int              @default(1)
  max_participants      Int              @default(10)
  description_html      String?
  photo_urls            String[]
  color                 String           @default("blue")
  waiver_required       Boolean          @default(true)
  self_reschedule_hours Int              @default(48)
  sort_index            Int              @default(0)
  created_at            DateTime         @default(now())
  updated_at            DateTime         @updatedAt
  rates                 Rate[]
  timeslots             Timeslot[]
  fees                  Fee[]
  order_items           OrderItem[]
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

model Timeslot {
  id               String      @id @default(cuid())
  activity_id      String
  activity         Activity    @relation(fields: [activity_id], references: [id])
  datetime         DateTime
  capacity_total   Int
  capacity_booked  Int         @default(0)
  is_overnight     Boolean     @default(false)
  status           String      @default("AVAILABLE")
  created_at       DateTime    @default(now())
  order_items      OrderItem[]
  @@index([activity_id, datetime])
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
