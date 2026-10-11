-- CreateEnum
CREATE TYPE "RateClassKind" AS ENUM ('ADULT', 'CHILD', 'INFANT', 'YOUTH', 'SENIOR', 'OTHER');

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "rate_class_id" TEXT,
ADD COLUMN     "rate_class_label" TEXT;

-- CreateTable
CREATE TABLE "RateClass" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "rate_id" TEXT NOT NULL,
    "kind" "RateClassKind" NOT NULL DEFAULT 'OTHER',
    "label" TEXT NOT NULL,
    "price_modifier_cents" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateClass_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateClass_operator_id_idx" ON "RateClass"("operator_id");

-- CreateIndex
CREATE INDEX "RateClass_rate_id_idx" ON "RateClass"("rate_id");

-- CreateIndex
CREATE UNIQUE INDEX "RateClass_operator_id_id_key" ON "RateClass"("operator_id", "id");

-- CreateIndex
CREATE INDEX "OrderItem_operator_id_rate_class_id_idx" ON "OrderItem"("operator_id", "rate_class_id");

-- AddForeignKey
ALTER TABLE "RateClass" ADD CONSTRAINT "RateClass_operator_id_rate_id_fkey" FOREIGN KEY ("operator_id", "rate_id") REFERENCES "Rate"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_operator_id_rate_class_id_fkey" FOREIGN KEY ("operator_id", "rate_class_id") REFERENCES "RateClass"("operator_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

