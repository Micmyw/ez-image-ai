BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '45s';

-- Add the versioned reference contract without reinterpreting any existing scene row.
-- No new tables, user-readable reference bindings, or production permissions are introduced.
ALTER TABLE "video_template_execution"
 DROP CONSTRAINT "video_template_shape_check",
 ADD CONSTRAINT "video_template_shape_check" CHECK (
 jsonb_typeof("templateSnapshot") IS NOT DISTINCT FROM 'object'
 AND jsonb_typeof("orderedRoleIdentities") IS NOT DISTINCT FROM 'array'
 AND jsonb_array_length("orderedRoleIdentities")=2
 AND "orderedRoleIdentities"->0->>'role' IS NOT DISTINCT FROM 'left'
 AND "orderedRoleIdentities"->1->>'role' IS NOT DISTINCT FROM 'right'
 AND "sceneState" IN ('PENDING','SUBMITTING','SUBMISSION_UNCERTAIN','GENERATING','STORING','READY','FAILED','NEEDS_REVIEW')
 AND ("sceneProviderTaskId" IS NULL OR "submittedAt" IS NOT NULL)
 AND (
  (("templateSnapshot"->>'effectId' IN ('hotel-lobby-duo','raindance-solo','raindance-duo')) IS TRUE
   AND ("resolvedInputIdentity" IS NULL OR ("sceneAssetId" IS NOT NULL AND "resolvedAt" IS NOT NULL)))
  OR
  ("templateSnapshot"->>'effectId' IS NOT DISTINCT FROM 'rumpelstiltskin-solo'
   AND "templateSnapshot"->>'schemaVersion' IS NOT DISTINCT FROM '2'
   AND "templateSnapshot"->>'executionKind' IS NOT DISTINCT FROM 'seedance-reference'
   AND jsonb_typeof("templateSnapshot"->'approvedMotionReference') IS NOT DISTINCT FROM 'object'
   AND "orderedRoleIdentities"->0->>'assetId' IS NOT DISTINCT FROM "orderedRoleIdentities"->1->>'assetId'
   AND "sceneState" IN ('PENDING','READY','FAILED','NEEDS_REVIEW')
   AND "sceneAssetId" IS NULL AND "submittedAt" IS NULL AND "sceneProviderTaskId" IS NULL
   AND "sceneProviderEvidence" IS NULL AND "sceneCallbackTokenHash" IS NULL
   AND "sceneSubmissionUncertain" IS FALSE
   AND ("resolvedInputIdentity" IS NULL OR
    ("resolvedAt" IS NOT NULL AND "resolvedInputIdentity"->>'source' IS NOT DISTINCT FROM 'subject-reference')))
 )
);

CREATE OR REPLACE FUNCTION guard_video_template_identity() RETURNS trigger AS $$
DECLARE parent "generation_job"%ROWTYPE; asset "media_asset"%ROWTYPE;
 reference_template boolean; subject_role text; subject_review jsonb;
BEGIN
 SELECT * INTO parent FROM "generation_job" WHERE "id"=NEW."jobId";
 IF parent."executionEngine" IS DISTINCT FROM 'video-workflow-v1'
  OR parent."inputSnapshot"->>'requestKind' IS DISTINCT FROM 'template-video'
  OR parent."inputSnapshot"->'videoEffectTemplate' IS DISTINCT FROM NEW."templateSnapshot"
  OR parent."inputSnapshot"->'roleInputIdentities' IS DISTINCT FROM NEW."orderedRoleIdentities" THEN
  RAISE EXCEPTION 'Template sidecar must match immutable parent contract' USING ERRCODE='55000';
 END IF;
 reference_template := NEW."templateSnapshot"->>'schemaVersion' IS NOT DISTINCT FROM '2'
  AND NEW."templateSnapshot"->>'executionKind' IS NOT DISTINCT FROM 'seedance-reference';
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
  IF reference_template THEN
   SELECT * INTO asset FROM "media_asset" WHERE "id"=NEW."orderedRoleIdentities"->0->>'assetId';
   IF asset."ownerType" IS DISTINCT FROM parent."ownerType" OR asset."ownerId" IS DISTINCT FROM parent."ownerId"
    OR asset."kind" IS DISTINCT FROM 'INPUT' OR asset."verificationEngine" IS DISTINCT FROM 'video-workflow-v1'
    OR NOT EXISTS(SELECT 1 FROM "generation_job_asset" WHERE "jobId"=NEW."jobId"
     AND "assetId"=asset."id" AND "assetChecksum"=asset."checksum" AND "role"='INPUT')
    OR NEW."inputReview"->>'status' IS DISTINCT FROM 'ALLOW'
    OR NEW."inputReview"->'left'->'decision'->>'decision' IS DISTINCT FROM 'ALLOW'
    OR NEW."inputReview"->'right'->'decision'->>'decision' IS DISTINCT FROM 'ALLOW'
    OR NEW."inputReview"->'motionTextDecision'->>'decision' IS DISTINCT FROM 'ALLOW'
    OR NEW."inputReview"->>'requestFingerprint' IS DISTINCT FROM parent."inputSnapshot"->>'requestFingerprint'
    OR NEW."resolvedInputIdentity"->'sourceReviewEvidence' IS DISTINCT FROM NEW."inputReview"
    OR NEW."resolvedInputIdentity"->>'source' IS DISTINCT FROM 'subject-reference'
   THEN RAISE EXCEPTION 'Reference input must bind its private reviewed subject' USING ERRCODE='55000'; END IF;
   FOREACH subject_role IN ARRAY ARRAY['left','right'] LOOP
    subject_review := NEW."inputReview"->subject_role;
    IF subject_review->>'assetId' IS DISTINCT FROM asset."id"
     OR subject_review->>'checksum' IS DISTINCT FROM asset."checksum"
     OR subject_review->>'objectKey' IS DISTINCT FROM asset."objectKey"
     OR subject_review->>'storageEtag' IS DISTINCT FROM asset."storageEtag"
     OR subject_review->>'storageVersionId' IS DISTINCT FROM asset."storageVersionId"
     OR (subject_review->>'verificationGeneration')::integer IS DISTINCT FROM asset."verificationGeneration"
     OR subject_review->>'safetyPolicyVersion' IS DISTINCT FROM NEW."templateSnapshot"->>'safetyPolicyVersion'
     OR subject_review->>'validUntil' IS NULL OR (subject_review->>'validUntil')::timestamptz <= clock_timestamp()
    THEN RAISE EXCEPTION 'Reference subject review must match sealed content' USING ERRCODE='55000'; END IF;
   END LOOP;
  ELSE
   IF NEW."sceneReview"->>'status' IS DISTINCT FROM 'ALLOW'
    OR NEW."resolvedInputIdentity"->'sceneReviewEvidence' IS DISTINCT FROM NEW."sceneReview"
   THEN RAISE EXCEPTION 'Resolved template input must bind approved stored content' USING ERRCODE='55000'; END IF;
  END IF;
  IF NEW."resolvedInputIdentity"->>'parentRequestFingerprint' IS DISTINCT FROM parent."inputSnapshot"->>'requestFingerprint'
   OR NEW."resolvedInputIdentity"->>'assetId' IS DISTINCT FROM asset."id"
   OR NEW."resolvedInputIdentity"->>'checksum' IS DISTINCT FROM asset."checksum"
   OR NEW."resolvedInputIdentity"->>'objectKey' IS DISTINCT FROM asset."objectKey"
   OR NEW."resolvedInputIdentity"->>'storageEtag' IS DISTINCT FROM asset."storageEtag"
   OR NEW."resolvedInputIdentity"->>'storageVersionId' IS DISTINCT FROM asset."storageVersionId"
   OR (NEW."resolvedInputIdentity"->>'verificationGeneration')::integer IS DISTINCT FROM asset."verificationGeneration"
   OR asset."finalizedAt" IS NULL OR asset."status" IS DISTINCT FROM 'READY' OR asset."deletedAt" IS NOT NULL
  THEN RAISE EXCEPTION 'Resolved template input must bind approved stored content' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION guard_video_template_sealed_asset() RETURNS trigger AS $$
DECLARE reference_binding boolean;
BEGIN
 reference_binding := EXISTS(SELECT 1 FROM "video_template_execution" WHERE "templateSnapshot"->>'schemaVersion'='2'
  AND "templateSnapshot"->>'executionKind'='seedance-reference'
  AND ("templateSnapshot"->'approvedMotionReference'->>'assetId'=OLD."id"
   OR ("resolvedInputIdentity" IS NOT NULL AND "resolvedInputIdentity"->>'assetId'=OLD."id")));
 IF (
  EXISTS(SELECT 1 FROM "video_template_execution" WHERE "sceneAssetId"=OLD."id" AND "resolvedInputIdentity" IS NOT NULL)
  OR reference_binding
 )
 AND (NEW."checksum" IS DISTINCT FROM OLD."checksum" OR NEW."objectKey" IS DISTINCT FROM OLD."objectKey"
  OR NEW."storageEtag" IS DISTINCT FROM OLD."storageEtag" OR NEW."storageVersionId" IS DISTINCT FROM OLD."storageVersionId"
  OR NEW."verificationGeneration" IS DISTINCT FROM OLD."verificationGeneration"
  OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize" OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType"
  OR (reference_binding AND (NEW."durationMillis" IS DISTINCT FROM OLD."durationMillis"
   OR NEW."width" IS DISTINCT FROM OLD."width" OR NEW."height" IS DISTINCT FROM OLD."height"))
  OR NEW."ownerType" IS DISTINCT FROM OLD."ownerType" OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId")
 THEN RAISE EXCEPTION 'Resolved template asset content is immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;

COMMIT;
