BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '45s';

-- CreateTable
CREATE TABLE "video_template_execution" (
    "jobId" TEXT NOT NULL,
    "templateSnapshot" JSONB NOT NULL,
    "orderedRoleIdentities" JSONB NOT NULL,
    "sceneState" TEXT NOT NULL DEFAULT 'PENDING',
    "sceneSubmissionUncertain" BOOLEAN NOT NULL DEFAULT false,
    "sceneCallbackTokenHash" TEXT,
    "sceneProviderTaskId" TEXT,
    "sceneProviderEvidence" JSONB,
    "sceneAssetId" TEXT,
    "inputReview" JSONB NOT NULL DEFAULT '{}',
    "sceneReview" JSONB NOT NULL DEFAULT '{}',
    "resolvedInputIdentity" JSONB,
    "stageData" JSONB NOT NULL DEFAULT '{}',
    "submittedAt" TIMESTAMPTZ(3),
    "acceptedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "video_template_execution_pkey" PRIMARY KEY ("jobId")
);

-- CreateIndex
CREATE UNIQUE INDEX "video_template_execution_sceneCallbackTokenHash_key" ON "video_template_execution"("sceneCallbackTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "video_template_execution_sceneProviderTaskId_key" ON "video_template_execution"("sceneProviderTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "video_template_execution_sceneAssetId_key" ON "video_template_execution"("sceneAssetId");

-- CreateIndex
CREATE INDEX "video_template_execution_sceneState_updatedAt_jobId_idx" ON "video_template_execution"("sceneState", "updatedAt", "jobId");

-- AddForeignKey
ALTER TABLE "video_template_execution" ADD CONSTRAINT "video_template_execution_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "generation_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_template_execution" ADD CONSTRAINT "video_template_execution_sceneAssetId_fkey" FOREIGN KEY ("sceneAssetId") REFERENCES "media_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- This migration adds a sidecar only. The latest explicit pending-video model
-- allowlist and the existing parent inputSnapshot immutability trigger remain intact.
ALTER TABLE "video_template_execution" ADD CONSTRAINT "video_template_shape_check" CHECK (
 jsonb_typeof("templateSnapshot") IS NOT DISTINCT FROM 'object'
 AND "templateSnapshot"->>'effectId' IS NOT DISTINCT FROM 'hotel-lobby-duo'
 AND jsonb_typeof("orderedRoleIdentities") IS NOT DISTINCT FROM 'array'
 AND jsonb_array_length("orderedRoleIdentities")=2
 AND "orderedRoleIdentities"->0->>'role' IS NOT DISTINCT FROM 'left'
 AND "orderedRoleIdentities"->1->>'role' IS NOT DISTINCT FROM 'right'
 AND "sceneState" IN ('PENDING','SUBMITTING','SUBMISSION_UNCERTAIN','GENERATING','STORING','READY','FAILED','NEEDS_REVIEW')
 AND ("sceneProviderTaskId" IS NULL OR "submittedAt" IS NOT NULL)
 AND ("resolvedInputIdentity" IS NULL OR ("sceneAssetId" IS NOT NULL AND "resolvedAt" IS NOT NULL))
);

CREATE FUNCTION guard_video_template_identity() RETURNS trigger AS $$
DECLARE parent "generation_job"%ROWTYPE; asset "media_asset"%ROWTYPE;
BEGIN
 SELECT * INTO parent FROM "generation_job" WHERE "id"=NEW."jobId";
 IF parent."executionEngine" IS DISTINCT FROM 'video-workflow-v1'
  OR parent."inputSnapshot"->>'requestKind' IS DISTINCT FROM 'template-video'
  OR parent."inputSnapshot"->'videoEffectTemplate' IS DISTINCT FROM NEW."templateSnapshot"
  OR parent."inputSnapshot"->'roleInputIdentities' IS DISTINCT FROM NEW."orderedRoleIdentities" THEN
  RAISE EXCEPTION 'Template sidecar must match immutable parent contract' USING ERRCODE='55000';
 END IF;
 IF TG_OP='UPDATE' AND (
  NEW."jobId" IS DISTINCT FROM OLD."jobId"
  OR NEW."templateSnapshot" IS DISTINCT FROM OLD."templateSnapshot"
  OR NEW."orderedRoleIdentities" IS DISTINCT FROM OLD."orderedRoleIdentities"
  OR (OLD."sceneCallbackTokenHash" IS NOT NULL AND NEW."sceneCallbackTokenHash" IS DISTINCT FROM OLD."sceneCallbackTokenHash")
  OR (OLD."sceneProviderTaskId" IS NOT NULL AND NEW."sceneProviderTaskId" IS DISTINCT FROM OLD."sceneProviderTaskId")
  OR (OLD."sceneProviderEvidence" IS NOT NULL AND NEW."sceneProviderEvidence" IS DISTINCT FROM OLD."sceneProviderEvidence")
  OR (OLD."sceneAssetId" IS NOT NULL AND NEW."sceneAssetId" IS DISTINCT FROM OLD."sceneAssetId")
  OR (OLD."resolvedInputIdentity" IS NOT NULL AND NEW."resolvedInputIdentity" IS DISTINCT FROM OLD."resolvedInputIdentity")
  OR (OLD."submittedAt" IS NOT NULL AND NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt")
 ) THEN RAISE EXCEPTION 'Template execution content and paid identities are immutable' USING ERRCODE='55000'; END IF;
 IF NEW."sceneAssetId" IS NOT NULL THEN
  SELECT * INTO asset FROM "media_asset" WHERE "id"=NEW."sceneAssetId";
  IF asset."kind" IS DISTINCT FROM 'INPUT' OR asset."ownerId" IS DISTINCT FROM parent."ownerId"
   OR asset."ownerType" IS DISTINCT FROM parent."ownerType" OR asset."verificationEngine" IS DISTINCT FROM 'video-workflow-v1'
   OR EXISTS(SELECT 1 FROM "generation_job_asset" WHERE "assetId"=asset."id" AND "role"='OUTPUT')
  THEN RAISE EXCEPTION 'Template scene must remain a private derived input' USING ERRCODE='55000'; END IF;
 END IF;
 IF NEW."resolvedInputIdentity" IS NOT NULL AND (TG_OP='INSERT' OR OLD."resolvedInputIdentity" IS NULL) THEN
  IF NEW."sceneReview"->>'status' IS DISTINCT FROM 'ALLOW'
   OR NEW."resolvedInputIdentity"->>'parentRequestFingerprint' IS DISTINCT FROM parent."inputSnapshot"->>'requestFingerprint'
   OR NEW."resolvedInputIdentity"->'sceneReviewEvidence' IS DISTINCT FROM NEW."sceneReview"
   OR NEW."resolvedInputIdentity"->>'assetId' IS DISTINCT FROM asset."id"
   OR NEW."resolvedInputIdentity"->>'checksum' IS DISTINCT FROM asset."checksum"
   OR NEW."resolvedInputIdentity"->>'objectKey' IS DISTINCT FROM asset."objectKey"
   OR NEW."resolvedInputIdentity"->>'storageEtag' IS DISTINCT FROM asset."storageEtag"
   OR NEW."resolvedInputIdentity"->>'storageVersionId' IS DISTINCT FROM asset."storageVersionId"
   OR (NEW."resolvedInputIdentity"->>'verificationGeneration')::integer IS DISTINCT FROM asset."verificationGeneration"
   OR asset."finalizedAt" IS NULL OR asset."status" IS DISTINCT FROM 'READY'
  THEN RAISE EXCEPTION 'Resolved template input must bind approved stored content' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "video_template_identity_immutable" BEFORE INSERT OR UPDATE ON "video_template_execution"
 FOR EACH ROW EXECUTE FUNCTION guard_video_template_identity();

CREATE FUNCTION guard_video_template_output_binding() RETURNS trigger AS $$
BEGIN
 IF NEW."role"='OUTPUT' AND EXISTS(SELECT 1 FROM "video_template_execution" WHERE "sceneAssetId"=NEW."assetId")
 THEN RAISE EXCEPTION 'Intermediate scene cannot be final OUTPUT' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "video_template_no_scene_output" BEFORE INSERT OR UPDATE ON "generation_job_asset"
 FOR EACH ROW EXECUTE FUNCTION guard_video_template_output_binding();

CREATE FUNCTION guard_video_template_sealed_asset() RETURNS trigger AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM "video_template_execution" WHERE "sceneAssetId"=OLD."id" AND "resolvedInputIdentity" IS NOT NULL)
 AND (NEW."checksum" IS DISTINCT FROM OLD."checksum" OR NEW."objectKey" IS DISTINCT FROM OLD."objectKey"
  OR NEW."storageEtag" IS DISTINCT FROM OLD."storageEtag" OR NEW."storageVersionId" IS DISTINCT FROM OLD."storageVersionId"
  OR NEW."verificationGeneration" IS DISTINCT FROM OLD."verificationGeneration"
  OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize" OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType"
  OR NEW."ownerType" IS DISTINCT FROM OLD."ownerType" OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId")
 THEN RAISE EXCEPTION 'Resolved template asset content is immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "video_template_sealed_asset_immutable" BEFORE UPDATE ON "media_asset"
 FOR EACH ROW EXECUTE FUNCTION guard_video_template_sealed_asset();

COMMIT;
