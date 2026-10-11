-- AlterEnum
ALTER TYPE "MessageTemplateKind" ADD VALUE 'BOOKING_CANCELLED';

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "cancellation_policy" JSONB;

-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "cancellation_policy" JSONB;

