-- Merchandise sale lines (reports overhaul): persist register merch/misc lines
-- as first-class rows + snapshot package attribution on booking OrderItems.
-- The add_on FK drop/re-add below is Prisma aligning a pre-existing NO ACTION
-- constraint to the datamodel's RESTRICT — functionally identical in Postgres.
-- DropForeignKey
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_operator_id_add_on_id_fkey";

-- AlterTable
ALTER TABLE "MerchandiseItem" ADD COLUMN     "variant" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "package_id" TEXT,
ADD COLUMN     "package_name" TEXT;

-- CreateTable
CREATE TABLE "OrderMerchandiseLine" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "merchandise_id" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'MERCHANDISE',
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'Uncategorized',
    "variant" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderMerchandiseLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderMerchandiseLine_operator_id_idx" ON "OrderMerchandiseLine"("operator_id");

-- CreateIndex
CREATE INDEX "OrderMerchandiseLine_order_id_idx" ON "OrderMerchandiseLine"("order_id");

-- CreateIndex
CREATE INDEX "OrderMerchandiseLine_operator_id_merchandise_id_idx" ON "OrderMerchandiseLine"("operator_id", "merchandise_id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderMerchandiseLine_operator_id_id_key" ON "OrderMerchandiseLine"("operator_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MerchandiseItem_operator_id_id_key" ON "MerchandiseItem"("operator_id", "id");

-- CreateIndex
CREATE INDEX "OrderItem_operator_id_package_id_idx" ON "OrderItem"("operator_id", "package_id");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_operator_id_add_on_id_fkey" FOREIGN KEY ("operator_id", "add_on_id") REFERENCES "PackageUpsell"("operator_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMerchandiseLine" ADD CONSTRAINT "OrderMerchandiseLine_operator_id_order_id_fkey" FOREIGN KEY ("operator_id", "order_id") REFERENCES "Order"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMerchandiseLine" ADD CONSTRAINT "OrderMerchandiseLine_operator_id_merchandise_id_fkey" FOREIGN KEY ("operator_id", "merchandise_id") REFERENCES "MerchandiseItem"("operator_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Backfill: historical POS merchandise/misc lines.
--
-- Before this table existed the register recorded merch/misc lines only in
-- OrderEvent(type = 'POS_LINE_ITEMS').metadata.lines. That JSON is real sale
-- data — recover it into queryable rows so reports cover history. Category
-- comes from the (still-present) catalog item where the line kept its id;
-- deleted/misc lines land in 'Uncategorized'. Deterministic ids make this
-- idempotent (re-running conflicts on the PK and inserts nothing).
-- ---------------------------------------------------------------------------
INSERT INTO "OrderMerchandiseLine"
  (id, operator_id, order_id, merchandise_id, kind, name, category, variant,
   quantity, unit_price_cents, created_at)
SELECT
  'omlbf' || substr(md5(e.id || '-' || l.ord::text), 1, 20),
  e.operator_id,
  e.order_id,
  m.id,
  CASE WHEN COALESCE(l.line->>'kind', 'MERCHANDISE') = 'MISC' THEN 'MISC' ELSE 'MERCHANDISE' END,
  COALESCE(l.line->>'label', 'Register item'),
  COALESCE(m.category, 'Uncategorized'),
  m.variant,
  GREATEST(COALESCE((l.line->>'quantity')::int, 1), 1),
  GREATEST(COALESCE((l.line->>'unitPriceCents')::int, 0), 0),
  e.created_at
FROM "OrderEvent" e
CROSS JOIN LATERAL jsonb_array_elements(e.metadata->'lines') WITH ORDINALITY AS l(line, ord)
LEFT JOIN "MerchandiseItem" m
  ON m.operator_id = e.operator_id AND m.id = l.line->>'merchandiseId'
WHERE e.type = 'POS_LINE_ITEMS'
  AND jsonb_typeof(e.metadata->'lines') = 'array'
ON CONFLICT (id) DO NOTHING;
