-- Platform onboarding tracking. NOT tenant data and deliberately NOT under the
-- tenant RLS policies: the whole purpose is a cross-client view, reached only
-- through adminPrisma behind the PLATFORM_ADMIN_AUTH_IDS gate.
--
-- Readiness (has activities, rates, timeslots, a waiver) is derived from the
-- client's real data on read, never stored, so it cannot drift from the truth.
-- Only what a human knows lives here.

CREATE TYPE "OnboardingStage" AS ENUM ('LEAD', 'PROVISIONED', 'CONFIGURING', 'TESTING', 'LIVE', 'CHURNED');

CREATE TABLE "OperatorOnboarding" (
  "id"             TEXT NOT NULL,
  "operator_id"    TEXT NOT NULL,
  "stage"          "OnboardingStage" NOT NULL DEFAULT 'PROVISIONED',
  "owner"          TEXT,
  "contact_name"   TEXT,
  "contact_email"  TEXT,
  "contact_phone"  TEXT,
  "target_live_on" TIMESTAMP(3),
  "went_live_on"   TIMESTAMP(3),
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OperatorOnboarding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OperatorOnboarding_operator_id_key" ON "OperatorOnboarding"("operator_id");
CREATE INDEX "OperatorOnboarding_stage_idx" ON "OperatorOnboarding"("stage");
ALTER TABLE "OperatorOnboarding" ADD CONSTRAINT "OperatorOnboarding_operator_id_fkey"
  FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OperatorNote" (
  "id"          TEXT NOT NULL,
  "operator_id" TEXT NOT NULL,
  "author"      TEXT NOT NULL,
  "body"        TEXT NOT NULL,
  "is_blocker"  BOOLEAN NOT NULL DEFAULT false,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OperatorNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OperatorNote_operator_id_created_at_idx" ON "OperatorNote"("operator_id", "created_at");
ALTER TABLE "OperatorNote" ADD CONSTRAINT "OperatorNote_operator_id_fkey"
  FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
