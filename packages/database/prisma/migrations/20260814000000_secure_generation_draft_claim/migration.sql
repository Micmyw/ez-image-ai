ALTER TABLE "generation_draft"
ADD COLUMN "claimTokenHash" TEXT,
ADD COLUMN "assetId" TEXT;

UPDATE "generation_draft"
SET "claimTokenHash" = md5("id" || ':' || clock_timestamp()::text) || md5(clock_timestamp()::text || ':' || "id")
WHERE "claimTokenHash" IS NULL;

ALTER TABLE "generation_draft" ALTER COLUMN "claimTokenHash" SET NOT NULL;
CREATE UNIQUE INDEX "generation_draft_claimTokenHash_key" ON "generation_draft"("claimTokenHash");
CREATE INDEX "generation_draft_assetId_idx" ON "generation_draft"("assetId");
