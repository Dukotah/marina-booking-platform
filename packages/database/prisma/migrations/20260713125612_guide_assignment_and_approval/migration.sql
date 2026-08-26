-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "approval_threshold_cents" INTEGER,
ADD COLUMN     "refund_requires_approval" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "GuideAssignment" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "timeslot_id" TEXT NOT NULL,
    "guide_id" TEXT NOT NULL,
    "role_label" TEXT,
    "assigned_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuideAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuideAssignment_operator_id_idx" ON "GuideAssignment"("operator_id");

-- CreateIndex
CREATE INDEX "GuideAssignment_timeslot_id_idx" ON "GuideAssignment"("timeslot_id");

-- CreateIndex
CREATE INDEX "GuideAssignment_guide_id_idx" ON "GuideAssignment"("guide_id");

-- CreateIndex
CREATE UNIQUE INDEX "GuideAssignment_operator_id_timeslot_id_guide_id_key" ON "GuideAssignment"("operator_id", "timeslot_id", "guide_id");

-- CreateIndex
CREATE UNIQUE INDEX "GuideAssignment_operator_id_id_key" ON "GuideAssignment"("operator_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StaffMember_operator_id_id_key" ON "StaffMember"("operator_id", "id");

-- AddForeignKey
ALTER TABLE "GuideAssignment" ADD CONSTRAINT "GuideAssignment_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideAssignment" ADD CONSTRAINT "GuideAssignment_operator_id_timeslot_id_fkey" FOREIGN KEY ("operator_id", "timeslot_id") REFERENCES "Timeslot"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideAssignment" ADD CONSTRAINT "GuideAssignment_operator_id_guide_id_fkey" FOREIGN KEY ("operator_id", "guide_id") REFERENCES "StaffMember"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

