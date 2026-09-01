-- Ad-hoc post-booking charges (fuel/cleaning/damage/late) added from the manifest.
CREATE TABLE "OrderCharge" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderCharge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderCharge_operator_id_idx" ON "OrderCharge"("operator_id");
CREATE INDEX "OrderCharge_order_id_idx" ON "OrderCharge"("order_id");
ALTER TABLE "OrderCharge" ADD CONSTRAINT "OrderCharge_operator_id_order_id_fkey"
    FOREIGN KEY ("operator_id", "order_id") REFERENCES "Order"("operator_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;
