-- CreateEnum
CREATE TYPE "GiftCertificateStatus" AS ENUM ('ACTIVE', 'REDEEMED', 'VOID', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PackageStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "hide_from_display" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hide_from_kiosk" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hide_from_register" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hide_price" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "GiftCertificate" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "value_cents" INTEGER NOT NULL,
    "activity_id" TEXT,
    "status" "GiftCertificateStatus" NOT NULL DEFAULT 'ACTIVE',
    "purchaser_email" TEXT,
    "recipient_name" TEXT,
    "recipient_email" TEXT,
    "message" TEXT,
    "expires_at" TIMESTAMP(3),
    "redeemed_order_id" TEXT,
    "redeemed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "name_internal" TEXT NOT NULL,
    "name_external" TEXT NOT NULL,
    "description_html" TEXT,
    "price_cents" INTEGER NOT NULL,
    "status" "PackageStatus" NOT NULL DEFAULT 'ACTIVE',
    "visible_online" BOOLEAN NOT NULL DEFAULT true,
    "sort_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageItem" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "activity_id" TEXT NOT NULL,
    "rate_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sort_index" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PackageItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageUpsell" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "activity_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_cents" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackageUpsell_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GiftCertificate_operator_id_idx" ON "GiftCertificate"("operator_id");

-- CreateIndex
CREATE INDEX "GiftCertificate_operator_id_status_idx" ON "GiftCertificate"("operator_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCertificate_operator_id_code_key" ON "GiftCertificate"("operator_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCertificate_operator_id_id_key" ON "GiftCertificate"("operator_id", "id");

-- CreateIndex
CREATE INDEX "Package_operator_id_idx" ON "Package"("operator_id");

-- CreateIndex
CREATE INDEX "Package_operator_id_status_idx" ON "Package"("operator_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Package_operator_id_id_key" ON "Package"("operator_id", "id");

-- CreateIndex
CREATE INDEX "PackageItem_operator_id_idx" ON "PackageItem"("operator_id");

-- CreateIndex
CREATE INDEX "PackageItem_operator_id_package_id_idx" ON "PackageItem"("operator_id", "package_id");

-- CreateIndex
CREATE UNIQUE INDEX "PackageItem_operator_id_id_key" ON "PackageItem"("operator_id", "id");

-- CreateIndex
CREATE INDEX "PackageUpsell_operator_id_idx" ON "PackageUpsell"("operator_id");

-- CreateIndex
CREATE INDEX "PackageUpsell_operator_id_activity_id_idx" ON "PackageUpsell"("operator_id", "activity_id");

-- CreateIndex
CREATE UNIQUE INDEX "PackageUpsell_operator_id_id_key" ON "PackageUpsell"("operator_id", "id");

-- AddForeignKey
ALTER TABLE "GiftCertificate" ADD CONSTRAINT "GiftCertificate_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCertificate" ADD CONSTRAINT "GiftCertificate_operator_id_activity_id_fkey" FOREIGN KEY ("operator_id", "activity_id") REFERENCES "Activity"("operator_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_operator_id_package_id_fkey" FOREIGN KEY ("operator_id", "package_id") REFERENCES "Package"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_operator_id_activity_id_fkey" FOREIGN KEY ("operator_id", "activity_id") REFERENCES "Activity"("operator_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_operator_id_rate_id_fkey" FOREIGN KEY ("operator_id", "rate_id") REFERENCES "Rate"("operator_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageUpsell" ADD CONSTRAINT "PackageUpsell_operator_id_activity_id_fkey" FOREIGN KEY ("operator_id", "activity_id") REFERENCES "Activity"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

