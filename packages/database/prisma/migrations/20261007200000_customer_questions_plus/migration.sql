-- AlterEnum
ALTER TYPE "QuestionType" ADD VALUE 'DATE';
ALTER TYPE "QuestionType" ADD VALUE 'PHONE';

-- AlterTable
ALTER TABLE "CustomerQuestion" ADD COLUMN     "applies_to_rate" TEXT,
ADD COLUMN     "show_in_confirmation" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "CustomerQuestion_operator_id_applies_to_rate_idx" ON "CustomerQuestion"("operator_id", "applies_to_rate");

-- AddForeignKey
ALTER TABLE "CustomerQuestion" ADD CONSTRAINT "CustomerQuestion_operator_id_applies_to_rate_fkey" FOREIGN KEY ("operator_id", "applies_to_rate") REFERENCES "Rate"("operator_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
