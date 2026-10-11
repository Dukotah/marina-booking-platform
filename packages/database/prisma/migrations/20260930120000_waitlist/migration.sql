-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('PENDING', 'NOTIFIED', 'BOOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "timeslot_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'PENDING',
    "notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaitlistEntry_operator_id_idx" ON "WaitlistEntry"("operator_id");

-- CreateIndex
CREATE INDEX "WaitlistEntry_operator_id_timeslot_id_status_idx" ON "WaitlistEntry"("operator_id", "timeslot_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_operator_id_id_key" ON "WaitlistEntry"("operator_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_operator_id_timeslot_id_email_key" ON "WaitlistEntry"("operator_id", "timeslot_id", "email");

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_operator_id_timeslot_id_fkey" FOREIGN KEY ("operator_id", "timeslot_id") REFERENCES "Timeslot"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

