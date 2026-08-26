-- CreateEnum
CREATE TYPE "GiftCardStatus" AS ENUM ('ACTIVE', 'REDEEMED', 'VOID', 'EXPIRED');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "gift_card_id" TEXT;

-- CreateTable
CREATE TABLE "GiftCard" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "initial_cents" INTEGER NOT NULL,
    "balance_cents" INTEGER NOT NULL,
    "status" "GiftCardStatus" NOT NULL DEFAULT 'ACTIVE',
    "purchaser_email" TEXT,
    "recipient_name" TEXT,
    "recipient_email" TEXT,
    "message" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GiftCard_operator_id_idx" ON "GiftCard"("operator_id");

-- CreateIndex
CREATE INDEX "GiftCard_operator_id_status_idx" ON "GiftCard"("operator_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_operator_id_code_key" ON "GiftCard"("operator_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_operator_id_id_key" ON "GiftCard"("operator_id", "id");

-- CreateIndex
CREATE INDEX "Payment_gift_card_id_idx" ON "Payment"("gift_card_id");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_operator_id_gift_card_id_fkey" FOREIGN KEY ("operator_id", "gift_card_id") REFERENCES "GiftCard"("operator_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

