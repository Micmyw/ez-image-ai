ALTER TYPE "MediaAssetStatus" ADD VALUE IF NOT EXISTS 'VERIFYING' AFTER 'UPLOADING';

ALTER TABLE "media_upload_session"
ADD COLUMN "multipartUploadId" TEXT;
