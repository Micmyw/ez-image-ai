-- CreateTable
CREATE TABLE "media_output_origin" (
    "assetId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "archiveState" TEXT NOT NULL DEFAULT 'PENDING',
    "archiveChecksum" TEXT,
    "archiveBytes" BIGINT,
    "archivedAt" TIMESTAMPTZ(3),
    "leaseToken" TEXT,
    "leasedUntil" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_output_origin_pkey" PRIMARY KEY ("assetId")
);

-- CreateIndex
CREATE INDEX "media_output_origin_archiveState_leasedUntil_idx" ON "media_output_origin"("archiveState", "leasedUntil");
