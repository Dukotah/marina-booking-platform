-- Checkout add-ons (life jackets, coolers, photo packages).
--
-- PackageUpsell existed as a schema-only model that nothing read. This makes it
-- sellable: an add-on can be global (activity_id NULL) rather than tied to one
-- activity, can be priced per guest or per booking, can cap quantity, and can carry
-- season stock.
--
-- stock_sold is moved only by a conditional UPDATE, never a read-then-write, so two
-- guests buying the last cooler at the same moment cannot both win.

ALTER TABLE "PackageUpsell" ALTER COLUMN "activity_id" DROP NOT NULL;

ALTER TABLE "PackageUpsell"
  ADD COLUMN "per_guest"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "max_per_booking" INTEGER,
  ADD COLUMN "stock_total"     INTEGER,
  ADD COLUMN "stock_sold"      INTEGER NOT NULL DEFAULT 0;

-- An add-on line on an order. The name is snapshotted so renaming an add-on later
-- cannot rewrite a receipt the guest already has.
ALTER TABLE "OrderItem"
  ADD COLUMN "add_on_id"   TEXT,
  ADD COLUMN "add_on_name" TEXT;

CREATE INDEX "OrderItem_operator_id_add_on_id_idx" ON "OrderItem"("operator_id", "add_on_id");

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_operator_id_add_on_id_fkey"
  FOREIGN KEY ("operator_id", "add_on_id") REFERENCES "PackageUpsell"("operator_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;
