-- AlterEnum
ALTER TYPE "ModerationStatus" ADD VALUE 'BYPASSED';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'MODERATION_ALERT';

-- CreateTable
CREATE TABLE "moderation_incident" (
    "id" TEXT NOT NULL,
    "activeKey" TEXT,
    "provider" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "lastErrorCode" TEXT NOT NULL,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "firstFailureAt" TIMESTAMPTZ(3) NOT NULL,
    "lastFailureAt" TIMESTAMPTZ(3) NOT NULL,
    "recoveredAt" TIMESTAMPTZ(3),
    "acknowledgedAt" TIMESTAMPTZ(3),
    "acknowledgedBy" TEXT,
    "alertedAt" TIMESTAMPTZ(3),

    CONSTRAINT "moderation_incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_incident_target" (
    "incidentId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,

    CONSTRAINT "moderation_incident_target_pkey" PRIMARY KEY ("incidentId","targetType","targetId")
);

-- CreateTable
CREATE TABLE "moderation_review" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "incidentId" TEXT,
    "provider" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RETRYING',
    "bypassed" BOOLEAN NOT NULL DEFAULT false,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "attemptEpoch" TEXT NOT NULL,
    "observedFailures" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT NOT NULL,
    "firstFailureAt" TIMESTAMPTZ(3) NOT NULL,
    "lastFailureAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedBy" TEXT,
    "resolutionReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "moderation_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "moderation_incident_activeKey_key" ON "moderation_incident"("activeKey");

-- CreateIndex
CREATE INDEX "moderation_incident_status_lastFailureAt_idx" ON "moderation_incident"("status", "lastFailureAt");

-- CreateIndex
CREATE INDEX "moderation_review_status_updatedAt_idx" ON "moderation_review"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "moderation_review_targetType_targetId_key" ON "moderation_review"("targetType", "targetId");

-- AddForeignKey
ALTER TABLE "moderation_incident_target" ADD CONSTRAINT "moderation_incident_target_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "moderation_incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_review" ADD CONSTRAINT "moderation_review_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "moderation_incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An outage permission is not a positive detector verdict. Preserve fingerprints and audit evidence.
ALTER TABLE "generation_quote" DROP CONSTRAINT "generation_quote_moderation_decision_check";
ALTER TABLE "generation_quote" ADD CONSTRAINT "generation_quote_moderation_decision_check"
 CHECK ("moderationDecision" IN ('ALLOW', 'BYPASS', 'LEGACY_UNREVIEWED'));
ALTER TABLE "generation_quote" ADD CONSTRAINT "generation_quote_bypass_fingerprint_check"
 CHECK ("moderationDecision" <> 'BYPASS' OR ("inputFingerprint" ~ '^[a-f0-9]{64}$' AND "moderationReasonCode" = 'MODERATION_TECHNICAL_FAILURE_BYPASS'));
ALTER TABLE "moderation_review" ADD CONSTRAINT "moderation_review_status_check"
 CHECK ("status" IN ('RETRYING', 'PENDING_REVIEW', 'RECHECKING', 'APPROVED', 'REJECTED', 'BLOCKED'));
ALTER TABLE "moderation_review" ADD CONSTRAINT "moderation_review_bypass_budget_check"
 CHECK (NOT "bypassed" OR "failureCount" >= 4);
ALTER TABLE "moderation_incident" ADD CONSTRAINT "moderation_incident_status_check"
 CHECK (("status" = 'OPEN' AND "activeKey" IS NOT NULL AND "recoveredAt" IS NULL) OR
        ("status" = 'RECOVERED' AND "activeKey" IS NULL AND "recoveredAt" IS NOT NULL));
ALTER TABLE "asset_moderation_result" ADD CONSTRAINT "asset_moderation_bypass_evidence_check"
 CHECK ("status"::text <> 'BYPASSED' OR ("assetChecksum" ~ '^[a-f0-9]{64}$' AND "validUntil" IS NOT NULL AND "reasonCode" = 'MODERATION_TECHNICAL_FAILURE_BYPASS'));

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
      AND (evidence."status" = 'APPROVED' OR (
        evidence."status"::text = 'BYPASSED'
        AND evidence."reasonCode" = 'MODERATION_TECHNICAL_FAILURE_BYPASS'
        AND EXISTS (SELECT 1 FROM "moderation_review" review
          WHERE review."targetType" = 'ASSET' AND review."targetId" = NEW."id"
            AND review."bypassed" AND review."failureCount" >= 4
            AND review."status" IN ('PENDING_REVIEW', 'RECHECKING', 'APPROVED'))
      ))
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


-- Private operations data has no browser/Data API access. Application role grants are explicit.
ALTER TABLE "moderation_incident" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "moderation_incident_target" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "moderation_review" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ezpic_app') THEN
   GRANT SELECT, INSERT, UPDATE, DELETE ON "moderation_incident", "moderation_incident_target", "moderation_review" TO ezpic_app;
   CREATE POLICY moderation_incident_app ON "moderation_incident" TO ezpic_app USING (true) WITH CHECK (true);
   CREATE POLICY moderation_incident_target_app ON "moderation_incident_target" TO ezpic_app USING (true) WITH CHECK (true);
   CREATE POLICY moderation_review_app ON "moderation_review" TO ezpic_app USING (true) WITH CHECK (true);
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
   REVOKE ALL ON "moderation_incident", "moderation_incident_target", "moderation_review" FROM anon;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
   REVOKE ALL ON "moderation_incident", "moderation_incident_target", "moderation_review" FROM authenticated;
 END IF;
END $$;
