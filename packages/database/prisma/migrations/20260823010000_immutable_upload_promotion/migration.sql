-- AlterEnum
ALTER TYPE "UploadSessionStatus" ADD VALUE 'FINALIZING';

-- AlterTable
ALTER TABLE "media_asset" ADD COLUMN     "finalizedAt" TIMESTAMPTZ(3),
ADD COLUMN     "storageEtag" TEXT,
ADD COLUMN     "storageVersionId" TEXT;

-- AlterTable
ALTER TABLE "media_upload_session" ADD COLUMN     "finalizationParts" JSONB,
ADD COLUMN     "finalizationToken" TEXT,
ADD COLUMN     "stagingObjectKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "media_upload_session_stagingObjectKey_key" ON "media_upload_session"("stagingObjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "media_upload_session_finalizationToken_key" ON "media_upload_session"("finalizationToken");
