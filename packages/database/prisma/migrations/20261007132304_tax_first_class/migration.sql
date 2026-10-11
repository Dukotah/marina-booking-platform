-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "tax_exempt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Fee" ADD COLUMN     "is_tax" BOOLEAN NOT NULL DEFAULT false;

