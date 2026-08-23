-- Moderation decisions are security evidence. Keep each attempt append-only and
-- bind READY authorization to the exact immutable asset bytes and policy generation.

CREATE TYPE "GenerationRetryRequestStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED');

ALTER TYPE "MediaAssetStatus" ADD VALUE 'VERIFICATION_FAILED';

ALTER TABLE "media_asset"
ADD COLUMN "verificationGeneration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "verificationAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "verificationProvider" TEXT,
ADD COLUMN "verificationRuleVersion" TEXT,
ADD COLUMN "verificationPolicyVersion" TEXT,
ADD COLUMN "verificationProviderTaskId" TEXT,
ADD COLUMN "verificationLeaseToken" TEXT,
ADD COLUMN "verificationLeasedUntil" TIMESTAMPTZ(3),
ADD COLUMN "verificationNextAttemptAt" TIMESTAMPTZ(3),
ADD COLUMN "verificationDeadlineAt" TIMESTAMPTZ(3),
ADD COLUMN "verificationExhaustedAt" TIMESTAMPTZ(3),
ADD COLUMN "verificationValidUntil" TIMESTAMPTZ(3),
ADD COLUMN "verificationSubmissionToken" TEXT,
ADD COLUMN "verificationSubmissionUncertain" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "verificationSubmittedAt" TIMESTAMPTZ(3),
ADD COLUMN "verificationLastErrorCode" TEXT;

ALTER TABLE "asset_moderation_result"
ADD COLUMN "assetChecksum" TEXT,
ADD COLUMN "verificationGeneration" INTEGER,
ADD COLUMN "attemptNumber" INTEGER,
ADD COLUMN "evidenceKind" "MediaAssetKind",
ADD COLUMN "providerTaskId" TEXT,
ADD COLUMN "ruleVersion" TEXT,
ADD COLUMN "policyVersion" TEXT,
ADD COLUMN "reasonCode" TEXT,
ADD COLUMN "validUntil" TIMESTAMPTZ(3);

WITH ranked_evidence AS (
  SELECT
    evidence."id",
    asset."kind",
    asset."checksum",
    ROW_NUMBER() OVER (
      PARTITION BY evidence."assetId"
      ORDER BY evidence."createdAt", evidence."id"
    )::INTEGER AS "attemptNumber"
  FROM "asset_moderation_result" evidence
  JOIN "media_asset" asset ON asset."id" = evidence."assetId"
)
UPDATE "asset_moderation_result" evidence
SET
  "assetChecksum" = COALESCE(ranked."checksum", 'legacy-untrusted:' || evidence."id"),
  "verificationGeneration" = 0,
  "attemptNumber" = ranked."attemptNumber",
  "evidenceKind" = ranked."kind",
  "ruleVersion" = COALESCE(NULLIF(evidence."categories"->>'ruleVersion', ''), 'legacy-untrusted'),
  "policyVersion" = 'legacy-untrusted',
  "reasonCode" = COALESCE(NULLIF(evidence."categories"->>'reasonCode', ''), 'LEGACY_UNTRUSTED')
FROM ranked_evidence ranked
WHERE ranked."id" = evidence."id";

ALTER TABLE "asset_moderation_result"
ALTER COLUMN "verificationGeneration" SET NOT NULL,
ALTER COLUMN "attemptNumber" SET NOT NULL,
ALTER COLUMN "evidenceKind" SET NOT NULL,
ALTER COLUMN "ruleVersion" SET NOT NULL,
ALTER COLUMN "policyVersion" SET NOT NULL,
ALTER COLUMN "reasonCode" SET NOT NULL;

DROP INDEX "asset_moderation_result_assetId_provider_key";

ALTER TABLE "asset_moderation_result"
DROP CONSTRAINT "asset_moderation_result_assetId_fkey",
ADD CONSTRAINT "asset_moderation_result_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "media_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "generation_job_asset" ADD COLUMN "assetChecksum" TEXT;

UPDATE "generation_job_asset" binding
SET "assetChecksum" = COALESCE(asset."checksum", 'legacy-untrusted:' || binding."assetId")
FROM "media_asset" asset
WHERE asset."id" = binding."assetId";

ALTER TABLE "generation_job_asset" ALTER COLUMN "assetChecksum" SET NOT NULL;

CREATE TABLE "generation_retry_request" (
  "id" TEXT NOT NULL,
  "ownerType" "OwnerType" NOT NULL,
  "ownerId" TEXT NOT NULL,
  "submittedByUserId" TEXT NOT NULL,
  "sourceJobId" TEXT NOT NULL,
  "resultJobId" TEXT,
  "quoteId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "status" "GenerationRetryRequestStatus" NOT NULL DEFAULT 'PROCESSING',
  "operationFingerprint" TEXT NOT NULL,
  "operationSnapshot" JSONB NOT NULL,
  "leaseToken" TEXT,
  "leasedUntil" TIMESTAMPTZ(3),
  "errorCode" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3),
  CONSTRAINT "generation_retry_request_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "generation_retry_request_resultJobId_key"
ON "generation_retry_request"("resultJobId");
CREATE UNIQUE INDEX "generation_retry_request_quoteId_key"
ON "generation_retry_request"("quoteId");
CREATE UNIQUE INDEX "generation_retry_request_leaseToken_key"
ON "generation_retry_request"("leaseToken");
CREATE INDEX "generation_retry_request_sourceJobId_createdAt_idx"
ON "generation_retry_request"("sourceJobId", "createdAt");
CREATE INDEX "generation_retry_request_status_leasedUntil_idx"
ON "generation_retry_request"("status", "leasedUntil");
CREATE UNIQUE INDEX "generation_retry_request_ownerType_ownerId_idempotencyKey_key"
ON "generation_retry_request"("ownerType", "ownerId", "idempotencyKey");

ALTER TABLE "generation_retry_request"
ADD CONSTRAINT "generation_retry_request_sourceJobId_fkey"
FOREIGN KEY ("sourceJobId") REFERENCES "generation_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "generation_retry_request_resultJobId_fkey"
FOREIGN KEY ("resultJobId") REFERENCES "generation_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "generation_retry_request_quoteId_fkey"
FOREIGN KEY ("quoteId") REFERENCES "generation_quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "generation_retry_request_operationFingerprint_check"
CHECK ("operationFingerprint" ~ '^[a-f0-9]{64}$');

CREATE UNIQUE INDEX "asset_moderation_result_generation_attempt_key"
ON "asset_moderation_result"("assetId", "verificationGeneration", "attemptNumber");
CREATE INDEX "asset_moderation_result_authorization_idx"
ON "asset_moderation_result"("assetId", "assetChecksum", "verificationGeneration", "status");
CREATE UNIQUE INDEX "media_asset_verificationLeaseToken_key"
ON "media_asset"("verificationLeaseToken");
CREATE UNIQUE INDEX "media_asset_verificationSubmissionToken_key"
ON "media_asset"("verificationSubmissionToken");
CREATE INDEX "media_asset_verification_recovery_idx"
ON "media_asset"("status", "verificationNextAttemptAt", "verificationLeasedUntil");
CREATE INDEX "media_asset_video_verification_recovery_idx"
ON "media_asset"("status", "verificationDeadlineAt", "verificationLeasedUntil");
CREATE INDEX "media_asset_ready_expiry_idx"
ON "media_asset"("status", "verificationValidUntil");

-- Existing rows may be legacy and untrusted. NOT VALID preserves that evidence
-- without letting any new incomplete approval authorize work.
ALTER TABLE "asset_moderation_result"
ADD CONSTRAINT "asset_moderation_result_approved_contract"
CHECK (
  "status" <> 'APPROVED'
  OR (
    "assetChecksum" IS NOT NULL
    AND "assetChecksum" ~ '^[A-Fa-f0-9]{64}$'
    AND "validUntil" IS NOT NULL
    AND "validUntil" > "createdAt"
  )
) NOT VALID;

-- Historical rows predate checksum-bound evidence and cannot authorize new work.
INSERT INTO "audit_log" (
  "id",
  "action",
  "targetType",
  "targetId",
  "before",
  "after",
  "metadata"
)
SELECT
  'audit_legacy_moderation_' || md5(asset."id"),
  'MEDIA_ASSET_LEGACY_EVIDENCE_QUARANTINED',
  'MEDIA_ASSET',
  asset."id",
  jsonb_build_object('status', asset."status"),
  jsonb_build_object(
    'status', 'QUARANTINED',
    'verificationLastErrorCode', 'LEGACY_EVIDENCE_UNTRUSTED'
  ),
  jsonb_build_object(
    'migration', '20260823015000_moderation_verification_recovery',
    'requiresReverification', true
  )
FROM "media_asset" asset
WHERE asset."status" = 'READY'
ON CONFLICT ("id") DO NOTHING;

UPDATE "media_asset"
SET
  "status" = 'QUARANTINED',
  "verificationLastErrorCode" = 'LEGACY_EVIDENCE_UNTRUSTED'
WHERE "status" = 'READY';

CREATE OR REPLACE FUNCTION prevent_asset_moderation_evidence_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Asset moderation evidence is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "asset_moderation_result_append_only"
BEFORE UPDATE OR DELETE ON "asset_moderation_result"
FOR EACH ROW EXECUTE FUNCTION prevent_asset_moderation_evidence_mutation();

CREATE OR REPLACE FUNCTION prevent_ready_media_asset_identity_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'READY' AND (
    OLD."ownerType" IS DISTINCT FROM NEW."ownerType"
    OR OLD."ownerId" IS DISTINCT FROM NEW."ownerId"
    OR OLD."kind" IS DISTINCT FROM NEW."kind"
    OR OLD."objectKey" IS DISTINCT FROM NEW."objectKey"
    OR OLD."mimeType" IS DISTINCT FROM NEW."mimeType"
    OR OLD."byteSize" IS DISTINCT FROM NEW."byteSize"
    OR OLD."width" IS DISTINCT FROM NEW."width"
    OR OLD."height" IS DISTINCT FROM NEW."height"
    OR OLD."durationMillis" IS DISTINCT FROM NEW."durationMillis"
    OR OLD."checksum" IS DISTINCT FROM NEW."checksum"
    OR OLD."storageEtag" IS DISTINCT FROM NEW."storageEtag"
    OR OLD."storageVersionId" IS DISTINCT FROM NEW."storageVersionId"
    OR OLD."finalizedAt" IS DISTINCT FROM NEW."finalizedAt"
    OR OLD."sourceUrl" IS DISTINCT FROM NEW."sourceUrl"
  ) THEN
    RAISE EXCEPTION 'READY media asset content identity is immutable until reverification starts';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "media_asset_ready_identity_immutable"
BEFORE UPDATE OF
  "ownerType",
  "ownerId",
  "kind",
  "objectKey",
  "mimeType",
  "byteSize",
  "width",
  "height",
  "durationMillis",
  "checksum",
  "storageEtag",
  "storageVersionId",
  "finalizedAt",
  "sourceUrl"
ON "media_asset"
FOR EACH ROW EXECUTE FUNCTION prevent_ready_media_asset_identity_mutation();

CREATE OR REPLACE FUNCTION enforce_media_asset_ready_evidence()
RETURNS TRIGGER AS $$
DECLARE
  ready_contract_changed BOOLEAN;
BEGIN
  IF NEW."status" <> 'READY' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    ready_contract_changed := TRUE;
  ELSE
    ready_contract_changed :=
      OLD."status" IS DISTINCT FROM NEW."status"
      OR OLD."checksum" IS DISTINCT FROM NEW."checksum"
      OR OLD."kind" IS DISTINCT FROM NEW."kind"
      OR OLD."verificationGeneration" IS DISTINCT FROM NEW."verificationGeneration"
      OR OLD."verificationAttemptCount" IS DISTINCT FROM NEW."verificationAttemptCount"
      OR OLD."verificationProvider" IS DISTINCT FROM NEW."verificationProvider"
      OR OLD."verificationRuleVersion" IS DISTINCT FROM NEW."verificationRuleVersion"
      OR OLD."verificationPolicyVersion" IS DISTINCT FROM NEW."verificationPolicyVersion"
      OR OLD."verificationProviderTaskId" IS DISTINCT FROM NEW."verificationProviderTaskId"
      OR OLD."verificationValidUntil" IS DISTINCT FROM NEW."verificationValidUntil";
  END IF;

  IF NOT ready_contract_changed THEN
    RETURN NEW;
  END IF;

  IF NEW."checksum" IS NULL
    OR NEW."verificationProvider" IS NULL
    OR NEW."verificationRuleVersion" IS NULL
    OR NEW."verificationPolicyVersion" IS NULL
    OR NEW."verificationValidUntil" IS NULL
    OR NEW."verificationValidUntil" <= CURRENT_TIMESTAMP
  THEN
    RAISE EXCEPTION 'READY media asset requires latest approved moderation evidence';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "asset_moderation_result" evidence
    WHERE evidence."assetId" = NEW."id"
      AND evidence."assetChecksum" = NEW."checksum"
      AND evidence."verificationGeneration" = NEW."verificationGeneration"
      AND evidence."attemptNumber" = NEW."verificationAttemptCount"
      AND evidence."evidenceKind" = NEW."kind"
      AND evidence."provider" = NEW."verificationProvider"
      AND evidence."providerTaskId" IS NOT DISTINCT FROM NEW."verificationProviderTaskId"
      AND evidence."ruleVersion" = NEW."verificationRuleVersion"
      AND evidence."policyVersion" = NEW."verificationPolicyVersion"
      AND evidence."status" = 'APPROVED'
      AND evidence."validUntil" = NEW."verificationValidUntil"
      AND evidence."validUntil" > CURRENT_TIMESTAMP
      AND NOT EXISTS (
        SELECT 1
        FROM "asset_moderation_result" later
        WHERE later."assetId" = evidence."assetId"
          AND later."verificationGeneration" = evidence."verificationGeneration"
          AND later."attemptNumber" > evidence."attemptNumber"
      )
  ) THEN
    RAISE EXCEPTION 'READY media asset requires latest approved moderation evidence';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "media_asset_ready_requires_approved_evidence"
BEFORE INSERT OR UPDATE OF
  "status",
  "checksum",
  "kind",
  "verificationGeneration",
  "verificationAttemptCount",
  "verificationProvider",
  "verificationRuleVersion",
  "verificationPolicyVersion",
  "verificationProviderTaskId",
  "verificationValidUntil"
ON "media_asset"
FOR EACH ROW EXECUTE FUNCTION enforce_media_asset_ready_evidence();
