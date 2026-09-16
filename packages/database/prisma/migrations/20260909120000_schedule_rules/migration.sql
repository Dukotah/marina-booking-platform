-- AlterTable
ALTER TABLE "BlackoutDate" ADD COLUMN     "activity_id" TEXT;

-- AlterTable
ALTER TABLE "Timeslot" ADD COLUMN     "schedule_rule_id" TEXT;

-- CreateTable
CREATE TABLE "ScheduleRule" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "activity_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" TEXT NOT NULL,
    "end_date" TEXT NOT NULL,
    "weekdays" INTEGER[],
    "start_minutes" INTEGER[],
    "capacity" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleRule_operator_id_idx" ON "ScheduleRule"("operator_id");

-- CreateIndex
CREATE INDEX "ScheduleRule_operator_id_activity_id_idx" ON "ScheduleRule"("operator_id", "activity_id");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleRule_operator_id_id_key" ON "ScheduleRule"("operator_id", "id");

-- CreateIndex
CREATE INDEX "BlackoutDate_operator_id_activity_id_idx" ON "BlackoutDate"("operator_id", "activity_id");

-- CreateIndex
CREATE INDEX "Timeslot_schedule_rule_id_idx" ON "Timeslot"("schedule_rule_id");

-- AddForeignKey
ALTER TABLE "Timeslot" ADD CONSTRAINT "Timeslot_schedule_rule_id_fkey" FOREIGN KEY ("schedule_rule_id") REFERENCES "ScheduleRule"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ScheduleRule" ADD CONSTRAINT "ScheduleRule_operator_id_activity_id_fkey" FOREIGN KEY ("operator_id", "activity_id") REFERENCES "Activity"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlackoutDate" ADD CONSTRAINT "BlackoutDate_operator_id_activity_id_fkey" FOREIGN KEY ("operator_id", "activity_id") REFERENCES "Activity"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

