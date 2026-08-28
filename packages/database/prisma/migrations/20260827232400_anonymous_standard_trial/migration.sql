-- CreateEnum
CREATE TYPE "GenerationServiceClass" AS ENUM ('STANDARD', 'GUEST_SLOW');

-- CreateEnum
CREATE TYPE "MediaRetentionClass" AS ENUM ('ACCOUNT', 'GUEST_TRIAL');

-- CreateEnum
CREATE TYPE "GuestTrialEligibility" AS ENUM ('AVAILABLE', 'IN_FLIGHT', 'CONSUMED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "GuestLinkState" AS ENUM ('NONE', 'LINKING', 'LINKED');

-- CreateEnum
CREATE TYPE "GuestRiskState" AS ENUM ('HELD', 'COMMITTED', 'RELEASED');

-- AlterTable: defaults preserve existing rows without rewriting historical business records.
ALTER TABLE "user" ADD COLUMN "isAnonymous" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "generation_job"
ADD COLUMN "serviceClass" "GenerationServiceClass" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN "dispatchEligibleAt" TIMESTAMPTZ(3),
ADD COLUMN "guestTrialId" TEXT;

ALTER TABLE "media_asset"
ADD COLUMN "retentionClass" "MediaRetentionClass" NOT NULL DEFAULT 'ACCOUNT',
ADD COLUMN "deleteAfter" TIMESTAMPTZ(3),
ADD COLUMN "watermarkVersion" TEXT,
ADD COLUMN "watermarkedAt" TIMESTAMPTZ(3),
ADD COLUMN "cleanStagingDeletedAt" TIMESTAMPTZ(3);

-- Guest upload credentials and capability bindings extend the existing private
-- upload session rather than introducing a parallel upload table.
ALTER TABLE "media_upload_session"
ADD COLUMN "guestCapabilityVersion" TEXT,
ADD COLUMN "guestOriginHash" TEXT,
ADD COLUMN "guestExpectedSha256" TEXT,
ADD COLUMN "guestCompletionConsumedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "guest_session_bootstrap" (
    "id" TEXT NOT NULL,
    -- Durable proof must exist before Better Auth creates the anonymous owner.
    -- The owner is bound under the claim advisory lock after User+Session creation.
    "ownerId" TEXT,
    "promotionPeriod" TEXT NOT NULL,
    "claimHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "claimedDraftId" TEXT,
    "sourceAssetId" TEXT,
    "principalLeaseToken" TEXT,
    "principalLeaseExpiresAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "guest_session_bootstrap_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guest_session_bootstrap_expiry_check" CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "guest_session_bootstrap_principal_lease_pair_check" CHECK (("principalLeaseToken" IS NULL) = ("principalLeaseExpiresAt" IS NULL)),
    CONSTRAINT "guest_session_bootstrap_owner_completion_pair_check" CHECK (("ownerId" IS NULL) = ("completedAt" IS NULL)),
    CONSTRAINT "guest_session_bootstrap_bound_lease_clear_check" CHECK ("ownerId" IS NULL OR ("principalLeaseToken" IS NULL AND "principalLeaseExpiresAt" IS NULL)),
    CONSTRAINT "guest_session_bootstrap_version_check" CHECK ("version" >= 0)
);

-- CreateTable
CREATE TABLE "guest_media_trial" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "promotionPeriod" TEXT NOT NULL,
    "eligibility" "GuestTrialEligibility" NOT NULL DEFAULT 'AVAILABLE',
    "sponsorCredits" BIGINT NOT NULL DEFAULT 4,
    "sourceDraftId" TEXT,
    "sourceBootstrapId" TEXT,
    "sourceAssetId" TEXT,
    "sourceSessionHash" TEXT NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "subnetHash" TEXT NOT NULL,
    "capabilityVersion" TEXT NOT NULL,
    "idempotencyFingerprint" TEXT NOT NULL,
    "replacementCount" INTEGER NOT NULL DEFAULT 0,
    "frozenQuotedRiskMicros" BIGINT NOT NULL,
    "riskState" "GuestRiskState" NOT NULL DEFAULT 'HELD',
    "projectedDispatchAt" TIMESTAMPTZ(3) NOT NULL,
    "estimateExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "currentJobId" TEXT,
    "consumedJobId" TEXT,
    "cleanupOutboxEventId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "linkedAt" TIMESTAMPTZ(3),
    "providerBoundaryAt" TIMESTAMPTZ(3),
    "terminalAt" TIMESTAMPTZ(3),
    "consumedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guest_media_trial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guest_media_trial_sponsor_credits_check" CHECK ("sponsorCredits" = 4),
    CONSTRAINT "guest_media_trial_job_separation_check" CHECK ("currentJobId" IS NULL OR "consumedJobId" IS NULL OR "currentJobId" <> "consumedJobId"),
    CONSTRAINT "guest_media_trial_replacement_count_check" CHECK ("replacementCount" >= 0 AND "replacementCount" <= 1),
    CONSTRAINT "guest_media_trial_risk_state_check" CHECK (
        "frozenQuotedRiskMicros" > 0 AND (
            ("riskState" = 'HELD' AND "providerBoundaryAt" IS NULL) OR
            ("riskState" = 'COMMITTED' AND "providerBoundaryAt" IS NOT NULL) OR
            ("riskState" = 'RELEASED' AND "providerBoundaryAt" IS NULL)
        )
    ),
    CONSTRAINT "guest_media_trial_estimate_window_check" CHECK ("estimateExpiresAt" >= "projectedDispatchAt" AND "estimateExpiresAt" <= "expiresAt"),
    CONSTRAINT "guest_media_trial_expiry_check" CHECK ("expiresAt" > "createdAt")
);

-- CreateTable
CREATE TABLE "guest_link_intent" (
    "id" TEXT NOT NULL,
    "trialId" TEXT,
    "claimedDraftId" TEXT,
    "anonymousOwnerId" TEXT NOT NULL,
    "promotionPeriod" TEXT NOT NULL,
    "sourceSessionHash" TEXT NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "returnPath" TEXT NOT NULL,
    "state" "GuestLinkState" NOT NULL DEFAULT 'NONE',
    "tokenHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "registeredUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "linkedAt" TIMESTAMPTZ(3),

    CONSTRAINT "guest_link_intent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guest_link_intent_exact_target_check" CHECK (("trialId" IS NULL) <> ("claimedDraftId" IS NULL)),
    CONSTRAINT "guest_link_intent_state_consistency_check" CHECK (
        ("state" = 'LINKED' AND "registeredUserId" IS NOT NULL AND "linkedAt" IS NOT NULL) OR
        ("state" IN ('NONE', 'LINKING') AND "registeredUserId" IS NULL AND "linkedAt" IS NULL)
    ),
    CONSTRAINT "guest_link_intent_return_path_check" CHECK ("returnPath" IN ('/try', '/create', '/pricing')),
    CONSTRAINT "guest_link_intent_expiry_check" CHECK ("expiresAt" > "createdAt")
);

-- CreateTable
CREATE TABLE "guest_result_access_grant" (
    "id" TEXT NOT NULL,
    "trialId" TEXT NOT NULL,
    "guestJobId" TEXT NOT NULL,
    "registeredUserId" TEXT NOT NULL,
    "grantTokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),

    CONSTRAINT "guest_result_access_grant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guest_result_access_grant_expiry_check" CHECK ("expiresAt" > "createdAt")
);

-- CreateTable
CREATE TABLE "guest_abuse_bucket" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "requestCount" BIGINT NOT NULL DEFAULT 0,
    "rejectionCount" BIGINT NOT NULL DEFAULT 0,
    "blockedUntil" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guest_abuse_bucket_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guest_abuse_bucket_window_check" CHECK ("windowEnd" > "windowStart"),
    CONSTRAINT "guest_abuse_bucket_counts_check" CHECK ("requestCount" >= 0 AND "rejectionCount" >= 0),
    CONSTRAINT "guest_abuse_bucket_version_check" CHECK ("version" >= 0)
);

-- CreateTable
CREATE TABLE "guest_risk_budget_bucket" (
    "id" TEXT NOT NULL,
    "promotionPeriod" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "reservedMicros" BIGINT NOT NULL DEFAULT 0,
    "consumedMicros" BIGINT NOT NULL DEFAULT 0,
    "hardLimitMicros" BIGINT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guest_risk_budget_bucket_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guest_risk_budget_nonnegative_check" CHECK ("reservedMicros" >= 0 AND "consumedMicros" >= 0),
    CONSTRAINT "guest_risk_budget_limit_check" CHECK ("hardLimitMicros" > 0 AND "reservedMicros" + "consumedMicros" <= "hardLimitMicros"),
    CONSTRAINT "guest_risk_budget_version_check" CHECK ("version" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "guest_session_bootstrap_claimHash_key" ON "guest_session_bootstrap"("claimHash");
CREATE UNIQUE INDEX "guest_session_bootstrap_idempotencyKey_key" ON "guest_session_bootstrap"("idempotencyKey");
CREATE UNIQUE INDEX "guest_session_bootstrap_claimedDraftId_key" ON "guest_session_bootstrap"("claimedDraftId");
CREATE UNIQUE INDEX "guest_session_bootstrap_sourceAssetId_key" ON "guest_session_bootstrap"("sourceAssetId");
CREATE UNIQUE INDEX "guest_session_bootstrap_principalLeaseToken_key" ON "guest_session_bootstrap"("principalLeaseToken");
CREATE UNIQUE INDEX "guest_session_bootstrap_ownerId_promotionPeriod_key" ON "guest_session_bootstrap"("ownerId", "promotionPeriod");
CREATE INDEX "guest_session_bootstrap_expiresAt_idx" ON "guest_session_bootstrap"("expiresAt");
CREATE INDEX "guest_session_bootstrap_principalLeaseExpiresAt_idx" ON "guest_session_bootstrap"("principalLeaseExpiresAt");

CREATE UNIQUE INDEX "guest_media_trial_currentJobId_key" ON "guest_media_trial"("currentJobId");
CREATE UNIQUE INDEX "guest_media_trial_consumedJobId_key" ON "guest_media_trial"("consumedJobId");
CREATE UNIQUE INDEX "guest_media_trial_cleanupOutboxEventId_key" ON "guest_media_trial"("cleanupOutboxEventId");
CREATE UNIQUE INDEX "guest_media_trial_sourceDraftId_key" ON "guest_media_trial"("sourceDraftId");
CREATE UNIQUE INDEX "guest_media_trial_sourceBootstrapId_key" ON "guest_media_trial"("sourceBootstrapId");
CREATE UNIQUE INDEX "guest_media_trial_idempotencyFingerprint_key" ON "guest_media_trial"("idempotencyFingerprint");
CREATE UNIQUE INDEX "guest_media_trial_ownerId_promotionPeriod_key" ON "guest_media_trial"("ownerId", "promotionPeriod");
CREATE UNIQUE INDEX "guest_media_trial_promotionPeriod_sourceSessionHash_key" ON "guest_media_trial"("promotionPeriod", "sourceSessionHash");
CREATE UNIQUE INDEX "guest_media_trial_promotionPeriod_deviceHash_key" ON "guest_media_trial"("promotionPeriod", "deviceHash");
CREATE INDEX "guest_media_trial_eligibility_expiresAt_idx" ON "guest_media_trial"("eligibility", "expiresAt");
CREATE INDEX "guest_media_trial_sourceAssetId_idx" ON "guest_media_trial"("sourceAssetId");

CREATE UNIQUE INDEX "guest_link_intent_tokenHash_key" ON "guest_link_intent"("tokenHash");
CREATE UNIQUE INDEX "guest_link_intent_idempotencyKey_key" ON "guest_link_intent"("idempotencyKey");
CREATE UNIQUE INDEX "guest_link_intent_trialId_key" ON "guest_link_intent"("trialId");
CREATE UNIQUE INDEX "guest_link_intent_claimedDraftId_key" ON "guest_link_intent"("claimedDraftId");
CREATE UNIQUE INDEX "guest_link_intent_anonymousOwnerId_promotionPeriod_key" ON "guest_link_intent"("anonymousOwnerId", "promotionPeriod");
CREATE INDEX "guest_link_intent_trialId_state_createdAt_idx" ON "guest_link_intent"("trialId", "state", "createdAt");
CREATE INDEX "guest_link_intent_anonymousOwnerId_state_expiresAt_idx" ON "guest_link_intent"("anonymousOwnerId", "state", "expiresAt");
CREATE INDEX "guest_link_intent_registeredUserId_idx" ON "guest_link_intent"("registeredUserId");

CREATE UNIQUE INDEX "guest_result_access_grant_grantTokenHash_key" ON "guest_result_access_grant"("grantTokenHash");
CREATE UNIQUE INDEX "guest_result_access_grant_guestJobId_registeredUserId_key" ON "guest_result_access_grant"("guestJobId", "registeredUserId");
CREATE INDEX "guest_result_access_grant_trialId_expiresAt_idx" ON "guest_result_access_grant"("trialId", "expiresAt");
CREATE INDEX "guest_result_access_grant_registeredUserId_idx" ON "guest_result_access_grant"("registeredUserId");

CREATE UNIQUE INDEX "guest_abuse_bucket_scope_subjectHash_windowStart_key" ON "guest_abuse_bucket"("scope", "subjectHash", "windowStart");
CREATE INDEX "guest_abuse_bucket_expiresAt_idx" ON "guest_abuse_bucket"("expiresAt");
CREATE INDEX "guest_abuse_bucket_blockedUntil_idx" ON "guest_abuse_bucket"("blockedUntil");

CREATE UNIQUE INDEX "guest_risk_budget_bucket_promotionPeriod_subjectHash_key" ON "guest_risk_budget_bucket"("promotionPeriod", "subjectHash");
CREATE INDEX "guest_risk_budget_bucket_expiresAt_idx" ON "guest_risk_budget_bucket"("expiresAt");

CREATE INDEX "generation_job_serviceClass_dispatchEligibleAt_status_idx" ON "generation_job"("serviceClass", "dispatchEligibleAt", "status");
CREATE INDEX "generation_job_guestTrialId_createdAt_id_idx" ON "generation_job"("guestTrialId", "createdAt", "id");
CREATE INDEX "media_asset_retentionClass_deleteAfter_idx" ON "media_asset"("retentionClass", "deleteAfter");

-- AddForeignKey
ALTER TABLE "guest_session_bootstrap" ADD CONSTRAINT "guest_session_bootstrap_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guest_session_bootstrap" ADD CONSTRAINT "guest_session_bootstrap_claimedDraftId_fkey" FOREIGN KEY ("claimedDraftId") REFERENCES "generation_draft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "guest_session_bootstrap" ADD CONSTRAINT "guest_session_bootstrap_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "media_asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "guest_media_trial" ADD CONSTRAINT "guest_media_trial_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "guest_media_trial" ADD CONSTRAINT "guest_media_trial_sourceDraftId_fkey" FOREIGN KEY ("sourceDraftId") REFERENCES "generation_draft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "guest_media_trial" ADD CONSTRAINT "guest_media_trial_sourceBootstrapId_fkey" FOREIGN KEY ("sourceBootstrapId") REFERENCES "guest_session_bootstrap"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "guest_media_trial" ADD CONSTRAINT "guest_media_trial_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "media_asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "guest_media_trial" ADD CONSTRAINT "guest_media_trial_currentJobId_fkey" FOREIGN KEY ("currentJobId") REFERENCES "generation_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "guest_media_trial" ADD CONSTRAINT "guest_media_trial_consumedJobId_fkey" FOREIGN KEY ("consumedJobId") REFERENCES "generation_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "guest_media_trial" ADD CONSTRAINT "guest_media_trial_cleanupOutboxEventId_fkey" FOREIGN KEY ("cleanupOutboxEventId") REFERENCES "outbox_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_guestTrialId_fkey" FOREIGN KEY ("guestTrialId") REFERENCES "guest_media_trial"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "guest_link_intent" ADD CONSTRAINT "guest_link_intent_trialId_fkey" FOREIGN KEY ("trialId") REFERENCES "guest_media_trial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "guest_link_intent" ADD CONSTRAINT "guest_link_intent_claimedDraftId_fkey" FOREIGN KEY ("claimedDraftId") REFERENCES "generation_draft"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "guest_link_intent" ADD CONSTRAINT "guest_link_intent_anonymousOwnerId_fkey" FOREIGN KEY ("anonymousOwnerId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "guest_link_intent" ADD CONSTRAINT "guest_link_intent_registeredUserId_fkey" FOREIGN KEY ("registeredUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "guest_result_access_grant" ADD CONSTRAINT "guest_result_access_grant_trialId_fkey" FOREIGN KEY ("trialId") REFERENCES "guest_media_trial"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guest_result_access_grant" ADD CONSTRAINT "guest_result_access_grant_guestJobId_fkey" FOREIGN KEY ("guestJobId") REFERENCES "generation_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "guest_result_access_grant" ADD CONSTRAINT "guest_result_access_grant_registeredUserId_fkey" FOREIGN KEY ("registeredUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
