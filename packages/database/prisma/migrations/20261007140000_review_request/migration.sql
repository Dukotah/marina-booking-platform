-- Post-trip review-request email/SMS.

-- AlterEnum
ALTER TYPE "MessageTemplateKind" ADD VALUE 'REVIEW_REQUEST';

-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "review_url" TEXT;

-- Concurrency-safe idempotency for the post-trip review sweep: only one sweep may
-- insert the REVIEW_SENT claim per order (mirrors OrderEvent_one_reminder_per_order).
CREATE UNIQUE INDEX "OrderEvent_one_review_per_order"
  ON "OrderEvent" ("operator_id", "order_id") WHERE "type" = 'REVIEW_SENT';
