-- CreateEnum
CREATE TYPE "ImageStatus" AS ENUM ('PENDING', 'READY', 'REJECTED', 'FAILED');

-- AlterTable
ALTER TABLE "ListingImage" ADD COLUMN     "dominantColor" TEXT,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "lqip" TEXT,
ADD COLUMN     "processedAt" TIMESTAMP(3),
ADD COLUMN     "status" "ImageStatus" NOT NULL DEFAULT 'PENDING',
ALTER COLUMN "objectKey" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "ListingImage_status_createdAt_idx" ON "ListingImage"("status", "createdAt");
