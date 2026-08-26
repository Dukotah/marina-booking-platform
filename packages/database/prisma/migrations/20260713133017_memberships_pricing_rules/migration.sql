-- CreateEnum
CREATE TYPE "MembershipKind" AS ENUM ('SEASON_PASS', 'PUNCH_CARD', 'MEMBER_RATE');

-- CreateEnum
CREATE TYPE "CustomerMembershipStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED', 'DEPLETED');

-- CreateEnum
CREATE TYPE "PricingRuleKind" AS ENUM ('SEASONAL', 'WEEKEND', 'DEMAND', 'GUIDE_MARKUP');

-- CreateEnum
CREATE TYPE "PricingAdjustmentType" AS ENUM ('PERCENT', 'FLAT');

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "MembershipKind" NOT NULL DEFAULT 'MEMBER_RATE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "discount_type" "DiscountType" NOT NULL DEFAULT 'PERCENT',
    "discount_value" INTEGER NOT NULL DEFAULT 0,
    "total_uses" INTEGER,
    "duration_days" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerMembership" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "membership_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "status" "CustomerMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "remaining_uses" INTEGER,
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PricingRuleKind" NOT NULL,
    "adjustment_type" "PricingAdjustmentType" NOT NULL DEFAULT 'PERCENT',
    "adjustment_value" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "activity_id" TEXT,
    "rate_id" TEXT,
    "starts_on" TIMESTAMP(3),
    "ends_on" TIMESTAMP(3),
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "demand_threshold" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Membership_operator_id_idx" ON "Membership"("operator_id");

-- CreateIndex
CREATE INDEX "Membership_operator_id_is_active_idx" ON "Membership"("operator_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_operator_id_id_key" ON "Membership"("operator_id", "id");

-- CreateIndex
CREATE INDEX "CustomerMembership_operator_id_idx" ON "CustomerMembership"("operator_id");

-- CreateIndex
CREATE INDEX "CustomerMembership_operator_id_customer_id_status_idx" ON "CustomerMembership"("operator_id", "customer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerMembership_operator_id_id_key" ON "CustomerMembership"("operator_id", "id");

-- CreateIndex
CREATE INDEX "PricingRule_operator_id_idx" ON "PricingRule"("operator_id");

-- CreateIndex
CREATE INDEX "PricingRule_operator_id_is_active_idx" ON "PricingRule"("operator_id", "is_active");

-- CreateIndex
CREATE INDEX "PricingRule_activity_id_idx" ON "PricingRule"("activity_id");

-- CreateIndex
CREATE INDEX "PricingRule_rate_id_idx" ON "PricingRule"("rate_id");

-- CreateIndex
CREATE UNIQUE INDEX "PricingRule_operator_id_id_key" ON "PricingRule"("operator_id", "id");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMembership" ADD CONSTRAINT "CustomerMembership_operator_id_membership_id_fkey" FOREIGN KEY ("operator_id", "membership_id") REFERENCES "Membership"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMembership" ADD CONSTRAINT "CustomerMembership_operator_id_customer_id_fkey" FOREIGN KEY ("operator_id", "customer_id") REFERENCES "Customer"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_operator_id_activity_id_fkey" FOREIGN KEY ("operator_id", "activity_id") REFERENCES "Activity"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_operator_id_rate_id_fkey" FOREIGN KEY ("operator_id", "rate_id") REFERENCES "Rate"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

