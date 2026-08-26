-- AlterTable
ALTER TABLE "Waiver" ADD COLUMN     "intro_html" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "WaiverSignature" ADD COLUMN     "acknowledgments" JSONB,
ADD COLUMN     "signer_dob" TIMESTAMP(3),
ADD COLUMN     "snapshot_html" TEXT,
ADD COLUMN     "waiver_version" INTEGER;

-- CreateTable
CREATE TABLE "WaiverClause" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "waiver_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "body_html" TEXT NOT NULL,
    "requires_initials" BOOLEAN NOT NULL DEFAULT true,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaiverClause_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaiverClause_operator_id_idx" ON "WaiverClause"("operator_id");

-- CreateIndex
CREATE INDEX "WaiverClause_operator_id_waiver_id_idx" ON "WaiverClause"("operator_id", "waiver_id");

-- CreateIndex
CREATE UNIQUE INDEX "WaiverClause_operator_id_id_key" ON "WaiverClause"("operator_id", "id");

-- AddForeignKey
ALTER TABLE "WaiverClause" ADD CONSTRAINT "WaiverClause_operator_id_waiver_id_fkey" FOREIGN KEY ("operator_id", "waiver_id") REFERENCES "Waiver"("operator_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

