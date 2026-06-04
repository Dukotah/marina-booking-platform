-- CreateEnum
CREATE TYPE "ActivityCategory" AS ENUM ('BOAT', 'WATERCRAFT', 'PATIO', 'LODGING', 'TOUR', 'CLASS', 'EVENT', 'EQUIPMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "ActivityStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "TimeslotStatus" AS ENUM ('AVAILABLE', 'FILLING_UP', 'FULL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('UPCOMING', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('CUSTOMER', 'STAFF', 'KIOSK');

-- CreateEnum
CREATE TYPE "OrderItemStatus" AS ENUM ('UPCOMING', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'CASH', 'GIFT_CARD', 'COMP');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PAID', 'REFUNDED', 'PARTIAL_REFUND', 'FAILED', 'PRE_AUTHORIZED');

-- CreateEnum
CREATE TYPE "PaymentProcessor" AS ENUM ('SQUARE', 'STRIPE');

-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('PERCENT', 'FLAT');

-- CreateEnum
CREATE TYPE "PromoType" AS ENUM ('ONE_CODE', 'PER_CUSTOMER', 'AUTO');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENT', 'FLAT');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'STAFF', 'GUIDE');

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "custom_domain" TEXT,
    "name_internal" TEXT NOT NULL,
    "name_external" TEXT NOT NULL,
    "location_code" TEXT NOT NULL,
    "website" TEXT,
    "phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    "country" TEXT NOT NULL DEFAULT 'US',
    "logo_dark_url" TEXT,
    "logo_light_url" TEXT,
    "brand_color" TEXT NOT NULL DEFAULT '#0ea5e9',
    "legal_adult_age" INTEGER NOT NULL DEFAULT 18,
    "plan" TEXT NOT NULL DEFAULT 'trial',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "timezone" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffMember" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "auth_user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "StaffRole" NOT NULL DEFAULT 'STAFF',
    "extra_permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffLocation" (
    "staff_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,

    CONSTRAINT "StaffLocation_pkey" PRIMARY KEY ("staff_id","location_id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "location_id" TEXT,
    "name_internal" TEXT NOT NULL,
    "name_external" TEXT NOT NULL,
    "status" "ActivityStatus" NOT NULL DEFAULT 'ACTIVE',
    "category" "ActivityCategory" NOT NULL DEFAULT 'OTHER',
    "visible_online" BOOLEAN NOT NULL DEFAULT true,
    "visible_kiosk" BOOLEAN NOT NULL DEFAULT true,
    "visible_register" BOOLEAN NOT NULL DEFAULT true,
    "min_participants" INTEGER NOT NULL DEFAULT 1,
    "max_participants" INTEGER NOT NULL DEFAULT 10,
    "description_html" TEXT,
    "photo_urls" TEXT[],
    "color" TEXT NOT NULL DEFAULT '#0ea5e9',
    "waiver_required" BOOLEAN NOT NULL DEFAULT true,
    "self_reschedule_hours" INTEGER NOT NULL DEFAULT 48,
    "sort_index" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rate" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "activity_id" TEXT NOT NULL,
    "name_internal" TEXT NOT NULL,
    "name_external" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "duration_minutes" INTEGER NOT NULL DEFAULT 240,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "online_only" BOOLEAN NOT NULL DEFAULT false,
    "internal_only" BOOLEAN NOT NULL DEFAULT false,
    "is_from_price" BOOLEAN NOT NULL DEFAULT false,
    "sort_index" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Timeslot" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "activity_id" TEXT NOT NULL,
    "datetime" TIMESTAMP(3) NOT NULL,
    "capacity_total" INTEGER NOT NULL,
    "capacity_booked" INTEGER NOT NULL DEFAULT 0,
    "is_overnight" BOOLEAN NOT NULL DEFAULT false,
    "status" "TimeslotStatus" NOT NULL DEFAULT 'AVAILABLE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Timeslot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "location_id" TEXT,
    "name" TEXT NOT NULL,
    "seat_capacity" INTEGER NOT NULL DEFAULT 1,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "out_of_service_qty" INTEGER NOT NULL DEFAULT 0,
    "enable_timer" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "tags" TEXT[],
    "notes" TEXT,
    "lifetime_value_cents" INTEGER NOT NULL DEFAULT 0,
    "total_bookings" INTEGER NOT NULL DEFAULT 0,
    "last_booking_at" TIMESTAMP(3),
    "waiver_on_file" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'UPCOMING',
    "created_by" "OrderChannel" NOT NULL DEFAULT 'CUSTOMER',
    "subtotal_cents" INTEGER NOT NULL,
    "tax_cents" INTEGER NOT NULL DEFAULT 0,
    "processing_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "tip_cents" INTEGER NOT NULL DEFAULT 0,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL,
    "amount_paid_cents" INTEGER NOT NULL DEFAULT 0,
    "balance_due_cents" INTEGER NOT NULL,
    "promo_code_id" TEXT,
    "heard_about_us" TEXT,
    "is_returning_guest" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "activity_id" TEXT NOT NULL,
    "rate_id" TEXT NOT NULL,
    "timeslot_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_cents" INTEGER NOT NULL,
    "status" "OrderItemStatus" NOT NULL DEFAULT 'UPCOMING',
    "waiver_signed" BOOLEAN NOT NULL DEFAULT false,
    "waiver_signed_at" TIMESTAMP(3),
    "driver_name" TEXT,
    "license_number" TEXT,
    "license_state" TEXT,
    "date_of_birth" TIMESTAMP(3),
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "has_driven_boat" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'CARD',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PAID',
    "amount_cents" INTEGER NOT NULL,
    "refunded_cents" INTEGER NOT NULL DEFAULT 0,
    "card_last_four" TEXT,
    "card_brand" TEXT,
    "cardholder_name" TEXT,
    "processor" "PaymentProcessor" NOT NULL DEFAULT 'SQUARE',
    "processor_transaction_id" TEXT,
    "is_manually_keyed" BOOLEAN NOT NULL DEFAULT false,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "actor" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fee" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "activity_id" TEXT,
    "name" TEXT NOT NULL,
    "type" "FeeType" NOT NULL DEFAULT 'PERCENT',
    "value" DOUBLE PRECISION NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "ignore_tax_exempt" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Fee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchandiseItem" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "cost_cents" INTEGER NOT NULL DEFAULT 0,
    "on_hand_qty" INTEGER,
    "reorder_alert_qty" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "MerchandiseItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoCode" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PromoType" NOT NULL DEFAULT 'ONE_CODE',
    "discount_type" "DiscountType" NOT NULL DEFAULT 'PERCENT',
    "discount_value" DOUBLE PRECISION NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "valid_from" TIMESTAMP(3),
    "valid_until" TIMESTAMP(3),
    "max_redemptions" INTEGER,
    "times_redeemed" INTEGER NOT NULL DEFAULT 0,
    "activity_ids" TEXT[],

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Waiver" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template_html" TEXT NOT NULL,
    "requires_minor_signature" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Waiver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaiverSignature" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "waiver_id" TEXT NOT NULL,
    "order_item_id" TEXT,
    "customer_id" TEXT,
    "signer_name" TEXT NOT NULL,
    "signed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signature_data" TEXT NOT NULL,
    "ip_address" TEXT,
    "is_minor" BOOLEAN NOT NULL DEFAULT false,
    "guardian_name" TEXT,

    CONSTRAINT "WaiverSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ActivityResources" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ActivityResources_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Operator_slug_key" ON "Operator"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Operator_custom_domain_key" ON "Operator"("custom_domain");

-- CreateIndex
CREATE UNIQUE INDEX "Operator_location_code_key" ON "Operator"("location_code");

-- CreateIndex
CREATE INDEX "Location_operator_id_idx" ON "Location"("operator_id");

-- CreateIndex
CREATE INDEX "StaffMember_operator_id_idx" ON "StaffMember"("operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "StaffMember_operator_id_auth_user_id_key" ON "StaffMember"("operator_id", "auth_user_id");

-- CreateIndex
CREATE INDEX "StaffLocation_location_id_idx" ON "StaffLocation"("location_id");

-- CreateIndex
CREATE INDEX "Activity_operator_id_idx" ON "Activity"("operator_id");

-- CreateIndex
CREATE INDEX "Activity_operator_id_category_idx" ON "Activity"("operator_id", "category");

-- CreateIndex
CREATE INDEX "Rate_operator_id_idx" ON "Rate"("operator_id");

-- CreateIndex
CREATE INDEX "Rate_activity_id_idx" ON "Rate"("activity_id");

-- CreateIndex
CREATE INDEX "Timeslot_operator_id_idx" ON "Timeslot"("operator_id");

-- CreateIndex
CREATE INDEX "Timeslot_activity_id_datetime_idx" ON "Timeslot"("activity_id", "datetime");

-- CreateIndex
CREATE INDEX "Resource_operator_id_idx" ON "Resource"("operator_id");

-- CreateIndex
CREATE INDEX "Customer_operator_id_idx" ON "Customer"("operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_operator_id_email_key" ON "Customer"("operator_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Order_order_number_key" ON "Order"("order_number");

-- CreateIndex
CREATE INDEX "Order_operator_id_idx" ON "Order"("operator_id");

-- CreateIndex
CREATE INDEX "Order_operator_id_status_idx" ON "Order"("operator_id", "status");

-- CreateIndex
CREATE INDEX "Order_customer_id_idx" ON "Order"("customer_id");

-- CreateIndex
CREATE INDEX "OrderItem_operator_id_idx" ON "OrderItem"("operator_id");

-- CreateIndex
CREATE INDEX "OrderItem_order_id_idx" ON "OrderItem"("order_id");

-- CreateIndex
CREATE INDEX "OrderItem_timeslot_id_idx" ON "OrderItem"("timeslot_id");

-- CreateIndex
CREATE INDEX "Payment_operator_id_idx" ON "Payment"("operator_id");

-- CreateIndex
CREATE INDEX "Payment_order_id_idx" ON "Payment"("order_id");

-- CreateIndex
CREATE INDEX "Note_operator_id_idx" ON "Note"("operator_id");

-- CreateIndex
CREATE INDEX "Note_order_id_idx" ON "Note"("order_id");

-- CreateIndex
CREATE INDEX "OrderEvent_operator_id_idx" ON "OrderEvent"("operator_id");

-- CreateIndex
CREATE INDEX "OrderEvent_order_id_idx" ON "OrderEvent"("order_id");

-- CreateIndex
CREATE INDEX "Fee_operator_id_idx" ON "Fee"("operator_id");

-- CreateIndex
CREATE INDEX "MerchandiseItem_operator_id_idx" ON "MerchandiseItem"("operator_id");

-- CreateIndex
CREATE INDEX "PromoCode_operator_id_idx" ON "PromoCode"("operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "PromoCode_operator_id_code_key" ON "PromoCode"("operator_id", "code");

-- CreateIndex
CREATE INDEX "Waiver_operator_id_idx" ON "Waiver"("operator_id");

-- CreateIndex
CREATE INDEX "WaiverSignature_operator_id_idx" ON "WaiverSignature"("operator_id");

-- CreateIndex
CREATE INDEX "WaiverSignature_waiver_id_idx" ON "WaiverSignature"("waiver_id");

-- CreateIndex
CREATE INDEX "Integration_operator_id_idx" ON "Integration"("operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_operator_id_key_key" ON "Integration"("operator_id", "key");

-- CreateIndex
CREATE INDEX "_ActivityResources_B_index" ON "_ActivityResources"("B");

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLocation" ADD CONSTRAINT "StaffLocation_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "StaffMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLocation" ADD CONSTRAINT "StaffLocation_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rate" ADD CONSTRAINT "Rate_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timeslot" ADD CONSTRAINT "Timeslot_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_rate_id_fkey" FOREIGN KEY ("rate_id") REFERENCES "Rate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_timeslot_id_fkey" FOREIGN KEY ("timeslot_id") REFERENCES "Timeslot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fee" ADD CONSTRAINT "Fee_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fee" ADD CONSTRAINT "Fee_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "Activity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchandiseItem" ADD CONSTRAINT "MerchandiseItem_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waiver" ADD CONSTRAINT "Waiver_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverSignature" ADD CONSTRAINT "WaiverSignature_waiver_id_fkey" FOREIGN KEY ("waiver_id") REFERENCES "Waiver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverSignature" ADD CONSTRAINT "WaiverSignature_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverSignature" ADD CONSTRAINT "WaiverSignature_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ActivityResources" ADD CONSTRAINT "_ActivityResources_A_fkey" FOREIGN KEY ("A") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ActivityResources" ADD CONSTRAINT "_ActivityResources_B_fkey" FOREIGN KEY ("B") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
