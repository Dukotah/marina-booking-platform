-- CreateTable
CREATE TABLE "ResourceBooking" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResourceBooking_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "ResourceBooking_operator_id_idx" ON "ResourceBooking"("operator_id");
-- CreateIndex
CREATE INDEX "ResourceBooking_resource_id_starts_at_ends_at_idx" ON "ResourceBooking"("resource_id", "starts_at", "ends_at");
-- CreateIndex
CREATE INDEX "ResourceBooking_order_item_id_idx" ON "ResourceBooking"("order_item_id");
-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_operator_id_id_key" ON "OrderItem"("operator_id", "id");
-- CreateIndex
CREATE UNIQUE INDEX "Resource_operator_id_id_key" ON "Resource"("operator_id", "id");
-- AddForeignKey
ALTER TABLE "ResourceBooking" ADD CONSTRAINT "ResourceBooking_operator_id_resource_id_fkey" FOREIGN KEY ("operator_id", "resource_id") REFERENCES "Resource"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ResourceBooking" ADD CONSTRAINT "ResourceBooking_operator_id_order_item_id_fkey" FOREIGN KEY ("operator_id", "order_item_id") REFERENCES "OrderItem"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
