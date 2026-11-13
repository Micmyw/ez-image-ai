-- No schema shape or historical evidence changes. A new input-only permission
-- records a proven terminal SeeAPI technical failure, never detector approval.
ALTER TABLE "asset_moderation_result" DROP CONSTRAINT "asset_moderation_bypass_evidence_check";
ALTER TABLE "asset_moderation_result" ADD CONSTRAINT "asset_moderation_bypass_evidence_check"
CHECK ("status"::text <> 'BYPASSED' OR (
  "assetChecksum" ~ '^[a-f0-9]{64}$' AND "validUntil" IS NOT NULL AND (
    "reasonCode" = 'MODERATION_TECHNICAL_FAILURE_BYPASS' OR COALESCE((
      "reasonCode" = 'SEEAPI_INPUT_TECHNICAL_FAILURE_DELEGATED_V1'
      AND "evidenceKind" = 'INPUT' AND "provider" = 'seeapi'
      AND "verificationGeneration" = 1 AND "providerTaskId" IS NOT NULL
      AND "rawEnvelope"->>'decision' = 'ERROR'
      AND "rawEnvelope"#>>'{evidence,requestId}' = "providerTaskId"
      AND "rawEnvelope"#>'{evidence,models}' = '["nsfw-filter-2"]'::jsonb
      AND "rawEnvelope"#>>'{evidence,seeapiFailure,taskId}' = "providerTaskId"
      AND "rawEnvelope"#>>'{evidence,seeapiFailure,status}' = 'failed'
      AND "rawEnvelope"#>>'{evidence,seeapiFailure,code}' IN (
        'RATE_LIMITED', 'DETECTION_REPORT_FAILED', 'PROVIDER_TIMEOUT'
      )
    ), false)
  )
));

-- Keep the historical four-failure budget. New SeeAPI asset failures are terminal
-- on the first observation; the evidence/READY guard supplies the narrow authority.
ALTER TABLE "moderation_review" DROP CONSTRAINT "moderation_review_bypass_budget_check";
ALTER TABLE "moderation_review" ADD CONSTRAINT "moderation_review_bypass_budget_check"
CHECK (NOT "bypassed" OR "failureCount" >= 4 OR (
  "targetType" = 'ASSET' AND "provider" = 'seeapi' AND "stage" = 'IMAGE' AND "failureCount" >= 1
));

CREATE OR REPLACE FUNCTION enforce_media_asset_ready_evidence()
RETURNS TRIGGER AS $$
DECLARE
  ready_contract_changed BOOLEAN;
BEGIN
  IF NEW."status" <> 'READY' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    ready_contract_changed := TRUE;
  ELSE
    ready_contract_changed :=
      OLD."status" IS DISTINCT FROM NEW."status"
      OR OLD."checksum" IS DISTINCT FROM NEW."checksum"
      OR OLD."kind" IS DISTINCT FROM NEW."kind"
      OR OLD."mimeType" IS DISTINCT FROM NEW."mimeType"
      OR OLD."ownerType" IS DISTINCT FROM NEW."ownerType"
      OR OLD."retentionClass" IS DISTINCT FROM NEW."retentionClass"
      OR OLD."verificationEngine" IS DISTINCT FROM NEW."verificationEngine"
      OR OLD."verificationGeneration" IS DISTINCT FROM NEW."verificationGeneration"
      OR OLD."verificationAttemptCount" IS DISTINCT FROM NEW."verificationAttemptCount"
      OR OLD."verificationProvider" IS DISTINCT FROM NEW."verificationProvider"
      OR OLD."verificationRuleVersion" IS DISTINCT FROM NEW."verificationRuleVersion"
      OR OLD."verificationPolicyVersion" IS DISTINCT FROM NEW."verificationPolicyVersion"
      OR OLD."verificationProviderTaskId" IS DISTINCT FROM NEW."verificationProviderTaskId"
      OR OLD."verificationValidUntil" IS DISTINCT FROM NEW."verificationValidUntil";
  END IF;
  IF NOT ready_contract_changed THEN RETURN NEW; END IF;
  IF NEW."checksum" IS NULL OR NEW."verificationProvider" IS NULL
    OR NEW."verificationRuleVersion" IS NULL OR NEW."verificationPolicyVersion" IS NULL
    OR NEW."verificationValidUntil" IS NULL OR NEW."verificationValidUntil" <= CURRENT_TIMESTAMP
  THEN RAISE EXCEPTION 'READY media asset requires latest approved moderation evidence'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "asset_moderation_result" evidence
    WHERE evidence."assetId" = NEW."id"
      AND evidence."assetChecksum" = NEW."checksum"
      AND evidence."verificationGeneration" = NEW."verificationGeneration"
      AND evidence."attemptNumber" = NEW."verificationAttemptCount"
      AND evidence."evidenceKind" = NEW."kind"
      AND evidence."provider" = NEW."verificationProvider"
      AND evidence."providerTaskId" IS NOT DISTINCT FROM NEW."verificationProviderTaskId"
      AND evidence."ruleVersion" = NEW."verificationRuleVersion"
      AND evidence."policyVersion" = NEW."verificationPolicyVersion"
      AND (evidence."status" = 'APPROVED' OR (
        evidence."status"::text = 'BYPASSED' AND (
          (evidence."reasonCode" = 'MODERATION_TECHNICAL_FAILURE_BYPASS'
            AND EXISTS (SELECT 1 FROM "moderation_review" review
              WHERE review."targetType" = 'ASSET' AND review."targetId" = NEW."id"
                AND review."bypassed" AND review."failureCount" >= 4
                AND review."status" IN ('PENDING_REVIEW', 'RECHECKING', 'APPROVED')))
          OR (evidence."reasonCode" = 'SEEAPI_INPUT_TECHNICAL_FAILURE_DELEGATED_V1'
            AND NEW."kind" = 'INPUT' AND NEW."ownerType" = 'USER' AND NEW."retentionClass" = 'ACCOUNT'
            AND NEW."verificationEngine" = 'legacy' AND NEW."verificationGeneration" = 1
            AND NEW."mimeType" IN ('image/jpeg', 'image/png', 'image/webp')
            AND NOT NEW."verificationSubmissionUncertain" AND NEW."finalizedAt" IS NOT NULL
            AND NEW."deletedAt" IS NULL
            AND EXISTS (SELECT 1 FROM "user" account_owner WHERE account_owner."id" = NEW."ownerId" AND NOT account_owner."isAnonymous")
            AND (NEW."deleteAfter" IS NULL OR NEW."deleteAfter" > CURRENT_TIMESTAMP)
            AND EXISTS (SELECT 1 FROM "moderation_review" review
              WHERE review."targetType" = 'ASSET' AND review."targetId" = NEW."id"
                AND review."provider" = 'seeapi' AND review."bypassed" AND review."failureCount" >= 1
                AND review."status" IN ('PENDING_REVIEW', 'RECHECKING', 'APPROVED')))
        )
      ))
      AND evidence."validUntil" = NEW."verificationValidUntil"
      AND evidence."validUntil" > CURRENT_TIMESTAMP
      AND NOT EXISTS (
        SELECT 1 FROM "asset_moderation_result" later
        WHERE later."assetId" = evidence."assetId"
          AND later."verificationGeneration" = evidence."verificationGeneration"
          AND later."attemptNumber" > evidence."attemptNumber"
      )
  ) THEN RAISE EXCEPTION 'READY media asset requires latest approved moderation evidence'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- These fields narrow delegation; their mutation must invoke the same guard.
DROP TRIGGER "media_asset_ready_requires_approved_evidence" ON "media_asset";
CREATE TRIGGER "media_asset_ready_requires_approved_evidence"
BEFORE INSERT OR UPDATE OF
  "status", "checksum", "kind", "mimeType", "ownerType", "retentionClass", "verificationEngine",
  "verificationGeneration", "verificationAttemptCount", "verificationProvider",
  "verificationRuleVersion", "verificationPolicyVersion", "verificationProviderTaskId", "verificationValidUntil"
ON "media_asset"
FOR EACH ROW EXECUTE FUNCTION enforce_media_asset_ready_evidence();
