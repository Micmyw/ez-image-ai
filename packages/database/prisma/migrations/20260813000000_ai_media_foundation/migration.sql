-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PurchaseType" AS ENUM ('SUBSCRIPTION', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "OwnerType" AS ENUM ('USER', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "GenerationJobStatus" AS ENUM ('RESERVED', 'DISPATCH_QUEUED', 'PROVIDER_PENDING', 'PROVIDER_RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "GenerationAttemptStatus" AS ENUM ('CREATED', 'SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "MediaAssetStatus" AS ENUM ('UPLOADING', 'READY', 'QUARANTINED', 'DELETED');

-- CreateEnum
CREATE TYPE "MediaAssetKind" AS ENUM ('INPUT', 'OUTPUT');

-- CreateEnum
CREATE TYPE "GenerationJobAssetRole" AS ENUM ('INPUT', 'OUTPUT');

-- CreateEnum
CREATE TYPE "UploadSessionStatus" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED', 'ABORTED');

-- CreateEnum
CREATE TYPE "ModerationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "StorageReservationStatus" AS ENUM ('ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CreditReservationStatus" AS ENUM ('ACTIVE', 'SETTLED', 'RELEASED');

-- CreateEnum
CREATE TYPE "CreditLedgerEntryType" AS ENUM ('GRANT', 'RESERVE', 'SETTLE', 'RELEASE', 'REFUND', 'DEBT_REPAYMENT', 'DEBT_INCURRED');

-- CreateEnum
CREATE TYPE "EventProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'LEASED', 'PROCESSED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BillingPeriodStatus" AS ENUM ('PENDING', 'ACTIVE', 'CLOSED', 'VOID');

-- CreateEnum
CREATE TYPE "GenerationDraftStatus" AS ENUM ('ACTIVE', 'SUBMITTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NotificationTarget" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('WELCOME', 'APP_UPDATE');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "role" TEXT,
    "banned" BOOLEAN,
    "banReason" TEXT,
    "banExpires" TIMESTAMP(3),
    "onboardingComplete" BOOLEAN NOT NULL DEFAULT false,
    "paymentsCustomerId" TEXT,
    "locale" TEXT,
    "twoFactorEnabled" BOOLEAN,
    "lastActiveOrganizationId" TEXT,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "impersonatedBy" TEXT,
    "activeOrganizationId" TEXT,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "password" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passkey" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "publicKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialID" TEXT NOT NULL,
    "counter" INTEGER NOT NULL,
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL,
    "transports" TEXT,
    "aaguid" TEXT,
    "createdAt" TIMESTAMP(3),

    CONSTRAINT "passkey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "twoFactor" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT NOT NULL,

    CONSTRAINT "twoFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "logo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "metadata" TEXT,
    "paymentsCustomerId" TEXT,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "inviterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "type" "PurchaseType" NOT NULL,
    "customerId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "priceId" TEXT NOT NULL,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_quote" (
    "id" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "productKey" TEXT NOT NULL,
    "catalogVersion" TEXT NOT NULL,
    "pricingVersion" TEXT NOT NULL,
    "credits" BIGINT NOT NULL,
    "costMicros" BIGINT NOT NULL,
    "inputSnapshot" JSONB NOT NULL,
    "pricingSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "generation_quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_job" (
    "id" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "productKey" TEXT NOT NULL,
    "catalogVersion" TEXT NOT NULL,
    "pricingVersion" TEXT NOT NULL,
    "creditsReserved" BIGINT NOT NULL,
    "inputSnapshot" JSONB NOT NULL,
    "pricingSnapshot" JSONB NOT NULL,
    "status" "GenerationJobStatus" NOT NULL DEFAULT 'RESERVED',
    "version" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "terminalAt" TIMESTAMPTZ(3),

    CONSTRAINT "generation_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_attempt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "providerModelId" TEXT NOT NULL,
    "providerTaskId" TEXT,
    "status" "GenerationAttemptStatus" NOT NULL DEFAULT 'CREATED',
    "providerCostMicros" BIGINT,
    "requestSnapshot" JSONB NOT NULL,
    "responseSnapshot" JSONB,
    "errorSnapshot" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "submittedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "generation_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_asset" (
    "id" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" "MediaAssetKind" NOT NULL,
    "status" "MediaAssetStatus" NOT NULL DEFAULT 'UPLOADING',
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" BIGINT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationMillis" BIGINT,
    "checksum" TEXT,
    "sourceUrl" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "media_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_upload_session" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "UploadSessionStatus" NOT NULL DEFAULT 'PENDING',
    "expectedBytes" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "media_upload_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_job_asset" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "role" "GenerationJobAssetRole" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_job_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_moderation_result" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "ModerationStatus" NOT NULL,
    "categories" JSONB NOT NULL,
    "rawEnvelope" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_moderation_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_usage_reservation" (
    "id" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "status" "StorageReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "referenceKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "releasedAt" TIMESTAMPTZ(3),

    CONSTRAINT "storage_usage_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_account" (
    "id" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "spendableCredits" BIGINT NOT NULL DEFAULT 0,
    "reservedCredits" BIGINT NOT NULL DEFAULT 0,
    "creditDebt" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credit_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_lot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "grantReferenceKey" TEXT NOT NULL,
    "grantedAmount" BIGINT NOT NULL,
    "remainingAmount" BIGINT NOT NULL,
    "reservedAmount" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_reservation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "settledAmount" BIGINT NOT NULL DEFAULT 0,
    "releasedAmount" BIGINT NOT NULL DEFAULT 0,
    "status" "CreditReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credit_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_reservation_allocation" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "settledAmount" BIGINT NOT NULL DEFAULT 0,
    "releasedAmount" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_reservation_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger_entry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "lotId" TEXT,
    "reservationId" TEXT,
    "type" "CreditLedgerEntryType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "referenceKey" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_webhook_event" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "providerTaskId" TEXT,
    "verifiedAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "envelope" JSONB NOT NULL,
    "status" "EventProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "processedAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,

    CONSTRAINT "provider_webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leasedUntil" TIMESTAMPTZ(3),
    "processedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_plan" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerPriceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "creditsPerPeriod" BIGINT NOT NULL,
    "priceMicros" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "billing_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSubscriptionId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "status" "SubscriptionStatus" NOT NULL,
    "currentPeriodStart" TIMESTAMPTZ(3),
    "currentPeriodEnd" TIMESTAMPTZ(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_period" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "BillingPeriodStatus" NOT NULL DEFAULT 'PENDING',
    "creditAmount" BIGINT NOT NULL,
    "grantReferenceKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "billing_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_event" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "normalizedTransactionId" TEXT,
    "verifiedAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "envelope" JSONB NOT NULL,
    "status" "EventProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "processedAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,

    CONSTRAINT "payment_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_config_override" (
    "id" TEXT NOT NULL,
    "configKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "value" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revertedAt" TIMESTAMPTZ(3),
    "revertedByUserId" TEXT,

    CONSTRAINT "runtime_config_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_bucket" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "count" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_limit_bucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_draft" (
    "id" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "productKey" TEXT,
    "inputSnapshot" JSONB NOT NULL,
    "status" "GenerationDraftStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "generation_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "link" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notification_preference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "target" "NotificationTarget" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_notification_preference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "passkey_userId_idx" ON "passkey"("userId");

-- CreateIndex
CREATE INDEX "passkey_credentialID_idx" ON "passkey"("credentialID");

-- CreateIndex
CREATE INDEX "twoFactor_secret_idx" ON "twoFactor"("secret");

-- CreateIndex
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE INDEX "member_organizationId_idx" ON "member"("organizationId");

-- CreateIndex
CREATE INDEX "member_userId_idx" ON "member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "member_organizationId_userId_key" ON "member"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "invitation_organizationId_idx" ON "invitation"("organizationId");

-- CreateIndex
CREATE INDEX "invitation_email_idx" ON "invitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_subscriptionId_key" ON "purchase"("subscriptionId");

-- CreateIndex
CREATE INDEX "purchase_subscriptionId_idx" ON "purchase"("subscriptionId");

-- CreateIndex
CREATE INDEX "generation_quote_ownerType_ownerId_createdAt_id_idx" ON "generation_quote"("ownerType", "ownerId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "generation_quote_expiresAt_idx" ON "generation_quote"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "generation_job_quoteId_key" ON "generation_job"("quoteId");

-- CreateIndex
CREATE INDEX "generation_job_ownerType_ownerId_createdAt_id_idx" ON "generation_job"("ownerType", "ownerId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "generation_job_status_updatedAt_idx" ON "generation_job"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "generation_job_ownerType_ownerId_idempotencyKey_key" ON "generation_job"("ownerType", "ownerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "generation_attempt_status_updatedAt_idx" ON "generation_attempt"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "generation_attempt_jobId_attemptNumber_key" ON "generation_attempt"("jobId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "generation_attempt_provider_providerTaskId_key" ON "generation_attempt"("provider", "providerTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "media_asset_objectKey_key" ON "media_asset"("objectKey");

-- CreateIndex
CREATE INDEX "media_asset_ownerType_ownerId_createdAt_id_idx" ON "media_asset"("ownerType", "ownerId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "media_asset_status_createdAt_idx" ON "media_asset"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "media_upload_session_tokenHash_key" ON "media_upload_session"("tokenHash");

-- CreateIndex
CREATE INDEX "media_upload_session_status_expiresAt_idx" ON "media_upload_session"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "generation_job_asset_assetId_idx" ON "generation_job_asset"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "generation_job_asset_jobId_assetId_role_key" ON "generation_job_asset"("jobId", "assetId", "role");

-- CreateIndex
CREATE INDEX "asset_moderation_result_status_createdAt_idx" ON "asset_moderation_result"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "asset_moderation_result_assetId_provider_key" ON "asset_moderation_result"("assetId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "storage_usage_reservation_referenceKey_key" ON "storage_usage_reservation"("referenceKey");

-- CreateIndex
CREATE INDEX "storage_usage_reservation_ownerType_ownerId_status_idx" ON "storage_usage_reservation"("ownerType", "ownerId", "status");

-- CreateIndex
CREATE INDEX "storage_usage_reservation_status_expiresAt_idx" ON "storage_usage_reservation"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "credit_account_ownerType_ownerId_key" ON "credit_account"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "credit_lot_accountId_expiresAt_createdAt_id_idx" ON "credit_lot"("accountId", "expiresAt", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_lot_accountId_grantReferenceKey_key" ON "credit_lot"("accountId", "grantReferenceKey");

-- CreateIndex
CREATE UNIQUE INDEX "credit_reservation_jobId_key" ON "credit_reservation"("jobId");

-- CreateIndex
CREATE INDEX "credit_reservation_accountId_status_createdAt_idx" ON "credit_reservation"("accountId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "credit_reservation_allocation_lotId_idx" ON "credit_reservation_allocation"("lotId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_reservation_allocation_reservationId_lotId_key" ON "credit_reservation_allocation"("reservationId", "lotId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_entry_referenceKey_key" ON "credit_ledger_entry"("referenceKey");

-- CreateIndex
CREATE INDEX "credit_ledger_entry_accountId_createdAt_id_idx" ON "credit_ledger_entry"("accountId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "credit_ledger_entry_reservationId_idx" ON "credit_ledger_entry"("reservationId");

-- CreateIndex
CREATE INDEX "provider_webhook_event_status_receivedAt_idx" ON "provider_webhook_event"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "provider_webhook_event_provider_providerEventId_key" ON "provider_webhook_event"("provider", "providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_dedupeKey_key" ON "outbox_event"("dedupeKey");

-- CreateIndex
CREATE INDEX "outbox_event_status_availableAt_createdAt_idx" ON "outbox_event"("status", "availableAt", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_event_leasedUntil_idx" ON "outbox_event"("leasedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "billing_plan_provider_providerPriceId_key" ON "billing_plan"("provider", "providerPriceId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_providerSubscriptionId_key" ON "subscription"("providerSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_purchaseId_key" ON "subscription"("purchaseId");

-- CreateIndex
CREATE INDEX "subscription_ownerType_ownerId_status_idx" ON "subscription"("ownerType", "ownerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "billing_period_grantReferenceKey_key" ON "billing_period"("grantReferenceKey");

-- CreateIndex
CREATE INDEX "billing_period_status_startsAt_idx" ON "billing_period"("status", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "billing_period_subscriptionId_startsAt_key" ON "billing_period"("subscriptionId", "startsAt");

-- CreateIndex
CREATE INDEX "payment_event_status_receivedAt_idx" ON "payment_event"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_event_provider_providerEventId_key" ON "payment_event"("provider", "providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "runtime_config_override_version_key" ON "runtime_config_override"("version");

-- CreateIndex
CREATE INDEX "runtime_config_override_configKey_active_version_idx" ON "runtime_config_override"("configKey", "active", "version");

-- CreateIndex
CREATE UNIQUE INDEX "runtime_config_override_configKey_version_key" ON "runtime_config_override"("configKey", "version");

-- CreateIndex
CREATE INDEX "audit_log_targetType_targetId_createdAt_idx" ON "audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_actorUserId_createdAt_idx" ON "audit_log"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "rate_limit_bucket_windowEnd_idx" ON "rate_limit_bucket"("windowEnd");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_bucket_action_subjectHash_windowStart_key" ON "rate_limit_bucket"("action", "subjectHash", "windowStart");

-- CreateIndex
CREATE INDEX "generation_draft_ownerType_ownerId_updatedAt_id_idx" ON "generation_draft"("ownerType", "ownerId", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "generation_draft_status_expiresAt_idx" ON "generation_draft"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "notification_userId_idx" ON "notification"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_notification_preference_userId_type_target_key" ON "user_notification_preference"("userId", "type", "target");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "twoFactor" ADD CONSTRAINT "twoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "generation_quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_attempt" ADD CONSTRAINT "generation_attempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "generation_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_upload_session" ADD CONSTRAINT "media_upload_session_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "media_asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_job_asset" ADD CONSTRAINT "generation_job_asset_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "generation_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_job_asset" ADD CONSTRAINT "generation_job_asset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "media_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_moderation_result" ADD CONSTRAINT "asset_moderation_result_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "media_asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_lot" ADD CONSTRAINT "credit_lot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "credit_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservation" ADD CONSTRAINT "credit_reservation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "credit_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservation" ADD CONSTRAINT "credit_reservation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "generation_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservation_allocation" ADD CONSTRAINT "credit_reservation_allocation_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "credit_reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservation_allocation" ADD CONSTRAINT "credit_reservation_allocation_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "credit_lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger_entry" ADD CONSTRAINT "credit_ledger_entry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "credit_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "billing_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_period" ADD CONSTRAINT "billing_period_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notification_preference" ADD CONSTRAINT "user_notification_preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Domain invariants Prisma cannot express. All credit and monetary values are BIGINT.
ALTER TABLE "generation_quote"
  ADD CONSTRAINT "generation_quote_credits_positive" CHECK ("credits" > 0),
  ADD CONSTRAINT "generation_quote_cost_micros_nonnegative" CHECK ("costMicros" >= 0);
ALTER TABLE "generation_job"
  ADD CONSTRAINT "generation_job_credits_reserved_positive" CHECK ("creditsReserved" > 0),
  ADD CONSTRAINT "generation_job_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "generation_attempt"
  ADD CONSTRAINT "generation_attempt_number_positive" CHECK ("attemptNumber" > 0),
  ADD CONSTRAINT "generation_attempt_cost_micros_nonnegative" CHECK ("providerCostMicros" IS NULL OR "providerCostMicros" >= 0);
ALTER TABLE "media_asset"
  ADD CONSTRAINT "media_asset_bytes_nonnegative" CHECK ("byteSize" >= 0);
ALTER TABLE "media_upload_session"
  ADD CONSTRAINT "media_upload_expected_bytes_nonnegative" CHECK ("expectedBytes" >= 0);
ALTER TABLE "storage_usage_reservation"
  ADD CONSTRAINT "storage_reservation_bytes_positive" CHECK ("bytes" > 0);
ALTER TABLE "credit_account"
  ADD CONSTRAINT "credit_account_balances_nonnegative" CHECK ("spendableCredits" >= 0 AND "reservedCredits" >= 0 AND "creditDebt" >= 0);
ALTER TABLE "credit_lot"
  ADD CONSTRAINT "credit_lot_amounts_valid" CHECK (
    "grantedAmount" >= 0 AND "remainingAmount" >= 0 AND "reservedAmount" >= 0
    AND "remainingAmount" + "reservedAmount" <= "grantedAmount"
  );
ALTER TABLE "credit_reservation"
  ADD CONSTRAINT "credit_reservation_amounts_valid" CHECK (
    "amount" > 0 AND "settledAmount" >= 0 AND "releasedAmount" >= 0
    AND "settledAmount" + "releasedAmount" <= "amount"
  );
ALTER TABLE "credit_reservation_allocation"
  ADD CONSTRAINT "credit_allocation_amounts_valid" CHECK (
    "amount" > 0 AND "settledAmount" >= 0 AND "releasedAmount" >= 0
    AND "settledAmount" + "releasedAmount" <= "amount"
  );
ALTER TABLE "credit_ledger_entry"
  ADD CONSTRAINT "credit_ledger_amount_nonnegative" CHECK ("amount" >= 0);
ALTER TABLE "billing_plan"
  ADD CONSTRAINT "billing_plan_amounts_nonnegative" CHECK ("creditsPerPeriod" >= 0 AND "priceMicros" >= 0);
ALTER TABLE "billing_period"
  ADD CONSTRAINT "billing_period_credit_nonnegative" CHECK ("creditAmount" >= 0),
  ADD CONSTRAINT "billing_period_dates_valid" CHECK ("endsAt" > "startsAt");
ALTER TABLE "rate_limit_bucket"
  ADD CONSTRAINT "rate_limit_bucket_count_nonnegative" CHECK ("count" >= 0),
  ADD CONSTRAINT "rate_limit_bucket_dates_valid" CHECK ("windowEnd" > "windowStart");

-- Operational hot-path indexes use partial predicates so terminal/history rows do not dominate.
CREATE INDEX "generation_job_nonterminal_updated_idx"
  ON "generation_job" ("updatedAt", "id")
  WHERE "status" IN ('RESERVED', 'DISPATCH_QUEUED', 'PROVIDER_PENDING', 'PROVIDER_RUNNING');
CREATE INDEX "provider_webhook_unprocessed_received_idx"
  ON "provider_webhook_event" ("receivedAt", "id")
  WHERE "status" IN ('RECEIVED', 'PROCESSING');
CREATE INDEX "outbox_pending_available_idx"
  ON "outbox_event" ("availableAt", "createdAt", "id")
  WHERE "status" IN ('PENDING', 'LEASED');
CREATE INDEX "payment_event_unprocessed_received_idx"
  ON "payment_event" ("receivedAt", "id")
  WHERE "status" IN ('RECEIVED', 'PROCESSING');
CREATE INDEX "credit_lot_expiring_spendable_idx"
  ON "credit_lot" ("accountId", "expiresAt", "createdAt", "id")
  WHERE "remainingAmount" > 0;
CREATE INDEX "media_upload_stale_pending_idx"
  ON "media_upload_session" ("expiresAt", "id")
  WHERE "status" = 'PENDING';

-- PostgreSQL permits multiple NULLs in a UNIQUE constraint. This enforces uniqueness only when normalized.
CREATE UNIQUE INDEX "payment_event_normalized_transaction_id_key"
  ON "payment_event" ("normalizedTransactionId")
  WHERE "normalizedTransactionId" IS NOT NULL;

-- The ledger is append-only. Corrections are represented by reverse entries, never mutation.
CREATE FUNCTION reject_credit_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger_entry is immutable; append a reversing entry instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER credit_ledger_entry_immutable
  BEFORE UPDATE OR DELETE ON "credit_ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION reject_credit_ledger_mutation();
