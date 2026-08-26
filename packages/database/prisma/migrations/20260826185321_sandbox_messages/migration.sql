-- CreateEnum
CREATE TYPE "SandboxChannel" AS ENUM ('EMAIL', 'SMS');

-- CreateTable
CREATE TABLE "SandboxMessage" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "channel" "SandboxChannel" NOT NULL,
    "kind" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "from_address" TEXT,
    "subject" TEXT,
    "body_html" TEXT,
    "body_text" TEXT,
    "order_id" TEXT,
    "order_number" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SandboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SandboxMessage_operator_id_idx" ON "SandboxMessage"("operator_id");

-- CreateIndex
CREATE INDEX "SandboxMessage_operator_id_created_at_idx" ON "SandboxMessage"("operator_id", "created_at");

-- AddForeignKey
ALTER TABLE "SandboxMessage" ADD CONSTRAINT "SandboxMessage_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
