-- CreateTable
CREATE TABLE "StaffNotificationPref" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "email_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sms_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sms_phone" TEXT,
    "activity_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffNotificationPref_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffNotificationPref_staff_id_key" ON "StaffNotificationPref"("staff_id");

-- CreateIndex
CREATE INDEX "StaffNotificationPref_operator_id_idx" ON "StaffNotificationPref"("operator_id");

-- AddForeignKey
ALTER TABLE "StaffNotificationPref" ADD CONSTRAINT "StaffNotificationPref_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffNotificationPref" ADD CONSTRAINT "StaffNotificationPref_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "StaffMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

