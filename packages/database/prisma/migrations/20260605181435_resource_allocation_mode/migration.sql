-- CreateEnum
CREATE TYPE "ResourceAllocationMode" AS ENUM ('SHARED_SEATS', 'WHOLE_UNIT');

-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "allocation_mode" "ResourceAllocationMode" NOT NULL DEFAULT 'SHARED_SEATS';
