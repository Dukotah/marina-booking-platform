-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "cart_hold_minutes" INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "CartHold" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "timeslot_id" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CartHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CartHold_operator_id_idx" ON "CartHold"("operator_id");

-- CreateIndex
CREATE INDEX "CartHold_operator_id_timeslot_id_expires_at_idx" ON "CartHold"("operator_id", "timeslot_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "CartHold_operator_id_id_key" ON "CartHold"("operator_id", "id");

-- AddForeignKey
ALTER TABLE "CartHold" ADD CONSTRAINT "CartHold_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartHold" ADD CONSTRAINT "CartHold_operator_id_timeslot_id_fkey" FOREIGN KEY ("operator_id", "timeslot_id") REFERENCES "Timeslot"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
