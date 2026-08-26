-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('TEXT', 'TEXTAREA', 'SELECT', 'CHECKBOX', 'NUMBER');

-- CreateEnum
CREATE TYPE "MessageTemplateKind" AS ENUM ('BOOKING_CONFIRMATION', 'BOOKING_REMINDER', 'REFUND_RECEIPT');

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "transportation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transportation_note" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "affiliate_code" TEXT,
ADD COLUMN     "affiliate_id" TEXT,
ADD COLUMN     "question_answers" JSONB;

-- CreateTable
CREATE TABLE "CustomerQuestion" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "QuestionType" NOT NULL DEFAULT 'TEXT',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "applies_to" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Affiliate" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "email" TEXT,
    "commission_percent" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Affiliate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "kind" "MessageTemplateKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "subject_override" TEXT,
    "body_override" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HeardAboutOption" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HeardAboutOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlackoutDate" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "location_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlackoutDate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GLAccount" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GLAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerQuestion_operator_id_idx" ON "CustomerQuestion"("operator_id");

-- CreateIndex
CREATE INDEX "CustomerQuestion_operator_id_applies_to_idx" ON "CustomerQuestion"("operator_id", "applies_to");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerQuestion_operator_id_id_key" ON "CustomerQuestion"("operator_id", "id");

-- CreateIndex
CREATE INDEX "Affiliate_operator_id_idx" ON "Affiliate"("operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "Affiliate_operator_id_code_key" ON "Affiliate"("operator_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Affiliate_operator_id_id_key" ON "Affiliate"("operator_id", "id");

-- CreateIndex
CREATE INDEX "MessageTemplate_operator_id_idx" ON "MessageTemplate"("operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_operator_id_kind_key" ON "MessageTemplate"("operator_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_operator_id_id_key" ON "MessageTemplate"("operator_id", "id");

-- CreateIndex
CREATE INDEX "HeardAboutOption_operator_id_idx" ON "HeardAboutOption"("operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "HeardAboutOption_operator_id_id_key" ON "HeardAboutOption"("operator_id", "id");

-- CreateIndex
CREATE INDEX "BlackoutDate_operator_id_idx" ON "BlackoutDate"("operator_id");

-- CreateIndex
CREATE INDEX "BlackoutDate_operator_id_date_idx" ON "BlackoutDate"("operator_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "BlackoutDate_operator_id_id_key" ON "BlackoutDate"("operator_id", "id");

-- CreateIndex
CREATE INDEX "GLAccount_operator_id_idx" ON "GLAccount"("operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "GLAccount_operator_id_code_key" ON "GLAccount"("operator_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "GLAccount_operator_id_id_key" ON "GLAccount"("operator_id", "id");

-- CreateIndex
CREATE INDEX "Order_operator_id_affiliate_id_idx" ON "Order"("operator_id", "affiliate_id");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_operator_id_affiliate_id_fkey" FOREIGN KEY ("operator_id", "affiliate_id") REFERENCES "Affiliate"("operator_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerQuestion" ADD CONSTRAINT "CustomerQuestion_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerQuestion" ADD CONSTRAINT "CustomerQuestion_operator_id_applies_to_fkey" FOREIGN KEY ("operator_id", "applies_to") REFERENCES "Activity"("operator_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Affiliate" ADD CONSTRAINT "Affiliate_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HeardAboutOption" ADD CONSTRAINT "HeardAboutOption_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlackoutDate" ADD CONSTRAINT "BlackoutDate_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlackoutDate" ADD CONSTRAINT "BlackoutDate_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GLAccount" ADD CONSTRAINT "GLAccount_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

