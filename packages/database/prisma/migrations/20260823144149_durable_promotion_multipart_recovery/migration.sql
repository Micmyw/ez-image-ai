-- AlterTable
ALTER TABLE "media_upload_session" ADD COLUMN     "promotionMultipartUploadId" TEXT,
ADD COLUMN     "promotionToken" TEXT;

-- CreateIndex
CREATE INDEX "media_upload_session_promotionMultipartUploadId_idx" ON "media_upload_session"("promotionMultipartUploadId");

-- CreateIndex
CREATE INDEX "media_upload_session_promotionToken_idx" ON "media_upload_session"("promotionToken");

-- A final multipart upload is recoverable only when its opaque database token
-- travels with it. Reject partially persisted tuples rather than guessing
-- whether a crash happened before or after durable registration.
ALTER TABLE "media_upload_session"
ADD CONSTRAINT "media_upload_session_promotion_pair_check"
CHECK (
	("promotionMultipartUploadId" IS NULL) = ("promotionToken" IS NULL)
);
