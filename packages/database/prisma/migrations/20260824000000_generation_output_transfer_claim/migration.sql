-- AlterTable
ALTER TABLE "media_asset" ADD COLUMN     "outputPromotionMultipartUploadId" TEXT,
ADD COLUMN     "outputStagingObjectKey" TEXT,
ADD COLUMN     "outputTransferLeaseExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "outputTransferToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "media_asset_outputTransferToken_key" ON "media_asset"("outputTransferToken");

-- CreateIndex
CREATE UNIQUE INDEX "media_asset_outputStagingObjectKey_key" ON "media_asset"("outputStagingObjectKey");

-- CreateIndex
CREATE INDEX "media_asset_outputTransferLeaseExpiresAt_idx" ON "media_asset"("outputTransferLeaseExpiresAt");

-- CreateIndex
CREATE INDEX "media_asset_outputPromotionMultipartUploadId_idx" ON "media_asset"("outputPromotionMultipartUploadId");
