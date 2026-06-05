-- CreateEnum
CREATE TYPE "GiftCardTransactionType" AS ENUM ('ISSUE', 'REDEEM', 'REFUND', 'ADJUST');

-- CreateTable
CREATE TABLE "GiftCard" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "initial_cents" INTEGER NOT NULL,
    "balance_cents" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "purchaser_name" TEXT,
    "purchaser_email" TEXT,
    "recipient_name" TEXT,
    "recipient_email" TEXT,
    "message" TEXT,
    "issued_by" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftCardTransaction" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "gift_card_id" TEXT NOT NULL,
    "type" "GiftCardTransactionType" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "balance_after_cents" INTEGER NOT NULL,
    "order_id" TEXT,
    "actor" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftCardTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GiftCard_operator_id_idx" ON "GiftCard"("operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_operator_id_code_key" ON "GiftCard"("operator_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_operator_id_id_key" ON "GiftCard"("operator_id", "id");

-- CreateIndex
CREATE INDEX "GiftCardTransaction_operator_id_idx" ON "GiftCardTransaction"("operator_id");

-- CreateIndex
CREATE INDEX "GiftCardTransaction_gift_card_id_idx" ON "GiftCardTransaction"("gift_card_id");

-- AddForeignKey
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_operator_id_gift_card_id_fkey" FOREIGN KEY ("operator_id", "gift_card_id") REFERENCES "GiftCard"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

