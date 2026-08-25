-- AlterTable
ALTER TABLE "generation_job" ADD COLUMN     "editSessionId" TEXT,
ADD COLUMN     "parentJobId" TEXT;

-- CreateTable
CREATE TABLE "image_edit_session" (
    "id" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "rootAssetId" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "image_edit_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "image_edit_session_ownerType_ownerId_updatedAt_id_idx" ON "image_edit_session"("ownerType", "ownerId", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "image_edit_session_rootAssetId_idx" ON "image_edit_session"("rootAssetId");

-- CreateIndex
CREATE INDEX "generation_job_editSessionId_createdAt_id_idx" ON "generation_job"("editSessionId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "generation_job_parentJobId_idx" ON "generation_job"("parentJobId");

-- AddForeignKey
ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_editSessionId_fkey" FOREIGN KEY ("editSessionId") REFERENCES "image_edit_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_parentJobId_fkey" FOREIGN KEY ("parentJobId") REFERENCES "generation_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
