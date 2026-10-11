-- CreateTable
CREATE TABLE "ChargePreset" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChargePreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChargePreset_operator_id_idx" ON "ChargePreset"("operator_id");

-- AddForeignKey
ALTER TABLE "ChargePreset" ADD CONSTRAINT "ChargePreset_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

