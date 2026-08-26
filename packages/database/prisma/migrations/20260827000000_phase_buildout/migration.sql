-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.

ALTER TYPE "PaymentStatus" ADD VALUE 'REQUIRES_ACTION';
ALTER TYPE "PaymentStatus" ADD VALUE 'DISPUTED';

-- CreateEnum
CREATE TYPE "SandboxPaymentOutcome" AS ENUM ('SUCCEEDED', 'REQUIRES_ACTION', 'DECLINED', 'TIMEOUT', 'DISPUTED');

-- CreateEnum
CREATE TYPE "SandboxPaymentAttemptStatus" AS ENUM ('QUEUED', 'REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'DISPUTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SandboxWebhookStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "ChannelKind" AS ENUM ('MOCK', 'VIATOR', 'GET_YOUR_GUIDE', 'EXPEDIA', 'TRIPADVISOR', 'AIRBNB_EXPERIENCES', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AccountingExportKind" AS ENUM ('QUICKBOOKS', 'XERO', 'CSV');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "idempotency_key" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "idempotency_key" TEXT;

-- CreateTable
CREATE TABLE "SandboxError" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "fingerprint" TEXT NOT NULL,
    "context" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SandboxError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SandboxPaymentAttempt" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "intent_id" TEXT,
    "amount_cents" INTEGER,
    "outcome" "SandboxPaymentOutcome" NOT NULL,
    "status" "SandboxPaymentAttemptStatus" NOT NULL DEFAULT 'QUEUED',
    "order_id" TEXT,
    "failure_code" TEXT,
    "idempotency_key" TEXT,
    "metadata" JSONB,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxPaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SandboxWebhook" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "SandboxWebhookStatus" NOT NULL DEFAULT 'PENDING',
    "delivered_at" TIMESTAMP(3),
    "error" TEXT,
    "attempt_id" TEXT,
    "replay_of_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SandboxWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SandboxClock" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "offset_seconds" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxClock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ChannelKind" NOT NULL DEFAULT 'MOCK',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "commission_percent" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelListing" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "activity_id" TEXT NOT NULL,
    "external_ref" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_synced_at" TIMESTAMP(3),
    "last_sync_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelBooking" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "commission_cents" INTEGER NOT NULL DEFAULT 0,
    "raw" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingExport" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "kind" "AccountingExportKind" NOT NULL DEFAULT 'CSV',
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generated_by" TEXT,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AccountingExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SandboxError_operator_id_idx" ON "SandboxError"("operator_id");

-- CreateIndex
CREATE INDEX "SandboxError_operator_id_created_at_idx" ON "SandboxError"("operator_id", "created_at");

-- CreateIndex
CREATE INDEX "SandboxError_operator_id_fingerprint_idx" ON "SandboxError"("operator_id", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "Order_operator_id_idempotency_key_key" ON "Order"("operator_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_operator_id_idempotency_key_key" ON "Payment"("operator_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "SandboxPaymentAttempt_operator_id_idx" ON "SandboxPaymentAttempt"("operator_id");

-- CreateIndex
CREATE INDEX "SandboxPaymentAttempt_operator_id_status_idx" ON "SandboxPaymentAttempt"("operator_id", "status");

-- CreateIndex
CREATE INDEX "SandboxPaymentAttempt_operator_id_created_at_idx" ON "SandboxPaymentAttempt"("operator_id", "created_at");

-- CreateIndex
CREATE INDEX "SandboxPaymentAttempt_order_id_idx" ON "SandboxPaymentAttempt"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "SandboxPaymentAttempt_operator_id_id_key" ON "SandboxPaymentAttempt"("operator_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SandboxPaymentAttempt_operator_id_intent_id_key" ON "SandboxPaymentAttempt"("operator_id", "intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "SandboxPaymentAttempt_operator_id_idempotency_key_key" ON "SandboxPaymentAttempt"("operator_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "SandboxWebhook_operator_id_idx" ON "SandboxWebhook"("operator_id");

-- CreateIndex
CREATE INDEX "SandboxWebhook_operator_id_created_at_idx" ON "SandboxWebhook"("operator_id", "created_at");

-- CreateIndex
CREATE INDEX "SandboxWebhook_operator_id_event_type_idx" ON "SandboxWebhook"("operator_id", "event_type");

-- CreateIndex
CREATE INDEX "SandboxWebhook_attempt_id_idx" ON "SandboxWebhook"("attempt_id");

-- CreateIndex
CREATE INDEX "SandboxWebhook_replay_of_id_idx" ON "SandboxWebhook"("replay_of_id");

-- CreateIndex
CREATE UNIQUE INDEX "SandboxWebhook_operator_id_id_key" ON "SandboxWebhook"("operator_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SandboxClock_operator_id_key" ON "SandboxClock"("operator_id");

-- CreateIndex
CREATE INDEX "AuditLog_operator_id_idx" ON "AuditLog"("operator_id");

-- CreateIndex
CREATE INDEX "AuditLog_operator_id_created_at_idx" ON "AuditLog"("operator_id", "created_at");

-- CreateIndex
CREATE INDEX "AuditLog_operator_id_action_created_at_idx" ON "AuditLog"("operator_id", "action", "created_at");

-- CreateIndex
CREATE INDEX "AuditLog_operator_id_entity_type_entity_id_idx" ON "AuditLog"("operator_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "AuditLog_operator_id_actor_created_at_idx" ON "AuditLog"("operator_id", "actor", "created_at");

-- CreateIndex
CREATE INDEX "Channel_operator_id_idx" ON "Channel"("operator_id");

-- CreateIndex
CREATE INDEX "Channel_operator_id_enabled_idx" ON "Channel"("operator_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_operator_id_name_key" ON "Channel"("operator_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_operator_id_id_key" ON "Channel"("operator_id", "id");

-- CreateIndex
CREATE INDEX "ChannelListing_operator_id_idx" ON "ChannelListing"("operator_id");

-- CreateIndex
CREATE INDEX "ChannelListing_operator_id_channel_id_idx" ON "ChannelListing"("operator_id", "channel_id");

-- CreateIndex
CREATE INDEX "ChannelListing_activity_id_idx" ON "ChannelListing"("activity_id");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelListing_operator_id_channel_id_activity_id_key" ON "ChannelListing"("operator_id", "channel_id", "activity_id");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelListing_operator_id_id_key" ON "ChannelListing"("operator_id", "id");

-- CreateIndex
CREATE INDEX "ChannelBooking_operator_id_idx" ON "ChannelBooking"("operator_id");

-- CreateIndex
CREATE INDEX "ChannelBooking_operator_id_channel_id_idx" ON "ChannelBooking"("operator_id", "channel_id");

-- CreateIndex
CREATE INDEX "ChannelBooking_order_id_idx" ON "ChannelBooking"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelBooking_operator_id_channel_id_external_ref_key" ON "ChannelBooking"("operator_id", "channel_id", "external_ref");

-- CreateIndex
CREATE INDEX "AccountingExport_operator_id_idx" ON "AccountingExport"("operator_id");

-- CreateIndex
CREATE INDEX "AccountingExport_operator_id_generated_at_idx" ON "AccountingExport"("operator_id", "generated_at");

-- CreateIndex
CREATE INDEX "AccountingExport_operator_id_kind_period_start_idx" ON "AccountingExport"("operator_id", "kind", "period_start");

-- AddForeignKey
ALTER TABLE "SandboxError" ADD CONSTRAINT "SandboxError_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxPaymentAttempt" ADD CONSTRAINT "SandboxPaymentAttempt_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxPaymentAttempt" ADD CONSTRAINT "SandboxPaymentAttempt_operator_id_order_id_fkey" FOREIGN KEY ("operator_id", "order_id") REFERENCES "Order"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxWebhook" ADD CONSTRAINT "SandboxWebhook_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxWebhook" ADD CONSTRAINT "SandboxWebhook_operator_id_attempt_id_fkey" FOREIGN KEY ("operator_id", "attempt_id") REFERENCES "SandboxPaymentAttempt"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxWebhook" ADD CONSTRAINT "SandboxWebhook_operator_id_replay_of_id_fkey" FOREIGN KEY ("operator_id", "replay_of_id") REFERENCES "SandboxWebhook"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxClock" ADD CONSTRAINT "SandboxClock_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelListing" ADD CONSTRAINT "ChannelListing_operator_id_channel_id_fkey" FOREIGN KEY ("operator_id", "channel_id") REFERENCES "Channel"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelListing" ADD CONSTRAINT "ChannelListing_operator_id_activity_id_fkey" FOREIGN KEY ("operator_id", "activity_id") REFERENCES "Activity"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelBooking" ADD CONSTRAINT "ChannelBooking_operator_id_channel_id_fkey" FOREIGN KEY ("operator_id", "channel_id") REFERENCES "Channel"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelBooking" ADD CONSTRAINT "ChannelBooking_operator_id_order_id_fkey" FOREIGN KEY ("operator_id", "order_id") REFERENCES "Order"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingExport" ADD CONSTRAINT "AccountingExport_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
