-- AlterTable
ALTER TABLE "PromoCode" ADD COLUMN     "auto_apply" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "per_customer_limit" INTEGER;

-- CreateTable
CREATE TABLE "PromoRedemption" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "promo_code_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "customer_email" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromoRedemption_operator_id_idx" ON "PromoRedemption"("operator_id");

-- CreateIndex
CREATE INDEX "PromoRedemption_promo_code_id_customer_email_idx" ON "PromoRedemption"("promo_code_id", "customer_email");

-- CreateIndex
CREATE INDEX "PromoRedemption_order_id_idx" ON "PromoRedemption"("order_id");

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_promo_code_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "PromoCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

