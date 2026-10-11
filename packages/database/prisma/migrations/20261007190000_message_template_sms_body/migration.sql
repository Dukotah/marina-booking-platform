-- Add an SMS-channel body override to MessageTemplate. Additive + nullable, so
-- existing rows and in-flight flows are unaffected (no backfill needed).
ALTER TABLE "MessageTemplate" ADD COLUMN "sms_body_override" TEXT;
