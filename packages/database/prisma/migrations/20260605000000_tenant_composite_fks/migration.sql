-- DropForeignKey
ALTER TABLE "Note" DROP CONSTRAINT "Note_order_id_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_customer_id_fkey";

-- DropForeignKey
ALTER TABLE "OrderEvent" DROP CONSTRAINT "OrderEvent_order_id_fkey";

-- DropForeignKey
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_activity_id_fkey";

-- DropForeignKey
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_order_id_fkey";

-- DropForeignKey
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_rate_id_fkey";

-- DropForeignKey
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_timeslot_id_fkey";

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_order_id_fkey";

-- DropForeignKey
ALTER TABLE "Rate" DROP CONSTRAINT "Rate_activity_id_fkey";

-- DropForeignKey
ALTER TABLE "Timeslot" DROP CONSTRAINT "Timeslot_activity_id_fkey";

-- DropForeignKey
ALTER TABLE "WaiverSignature" DROP CONSTRAINT "WaiverSignature_waiver_id_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "Activity_operator_id_id_key" ON "Activity"("operator_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_operator_id_id_key" ON "Customer"("operator_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Order_operator_id_id_key" ON "Order"("operator_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Rate_operator_id_id_key" ON "Rate"("operator_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Timeslot_operator_id_id_key" ON "Timeslot"("operator_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Waiver_operator_id_id_key" ON "Waiver"("operator_id", "id");

-- AddForeignKey
ALTER TABLE "Rate" ADD CONSTRAINT "Rate_operator_id_activity_id_fkey" FOREIGN KEY ("operator_id", "activity_id") REFERENCES "Activity"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timeslot" ADD CONSTRAINT "Timeslot_operator_id_activity_id_fkey" FOREIGN KEY ("operator_id", "activity_id") REFERENCES "Activity"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_operator_id_customer_id_fkey" FOREIGN KEY ("operator_id", "customer_id") REFERENCES "Customer"("operator_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_operator_id_order_id_fkey" FOREIGN KEY ("operator_id", "order_id") REFERENCES "Order"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_operator_id_activity_id_fkey" FOREIGN KEY ("operator_id", "activity_id") REFERENCES "Activity"("operator_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_operator_id_rate_id_fkey" FOREIGN KEY ("operator_id", "rate_id") REFERENCES "Rate"("operator_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_operator_id_timeslot_id_fkey" FOREIGN KEY ("operator_id", "timeslot_id") REFERENCES "Timeslot"("operator_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_operator_id_order_id_fkey" FOREIGN KEY ("operator_id", "order_id") REFERENCES "Order"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_operator_id_order_id_fkey" FOREIGN KEY ("operator_id", "order_id") REFERENCES "Order"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_operator_id_order_id_fkey" FOREIGN KEY ("operator_id", "order_id") REFERENCES "Order"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverSignature" ADD CONSTRAINT "WaiverSignature_operator_id_waiver_id_fkey" FOREIGN KEY ("operator_id", "waiver_id") REFERENCES "Waiver"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

