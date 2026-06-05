-- CreateTable
CREATE TABLE "CustomerOtp" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerOtp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerOtp_operator_id_idx" ON "CustomerOtp"("operator_id");

-- CreateIndex
CREATE INDEX "CustomerOtp_operator_id_email_idx" ON "CustomerOtp"("operator_id", "email");

-- AddForeignKey
ALTER TABLE "CustomerOtp" ADD CONSTRAINT "CustomerOtp_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

