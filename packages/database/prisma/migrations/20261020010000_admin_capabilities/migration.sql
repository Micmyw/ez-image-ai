-- AlterEnum
ALTER TYPE "CreditLedgerEntryType" ADD VALUE 'ADMIN_DEDUCT';

-- AlterTable
ALTER TABLE "subscription" ADD COLUMN     "initialPaymentEvidence" JSONB;

-- CreateTable
CREATE TABLE "admin_service_account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "disabledAt" TIMESTAMPTZ(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_service_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_api_key" (
    "id" TEXT NOT NULL,
    "serviceAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_execution" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "credentialId" TEXT,
    "scope" JSONB NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "targetId" TEXT,
    "status" TEXT NOT NULL,
    "response" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "admin_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_bot_config" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "encryptedSecrets" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_bot_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_bot_receipt" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "results" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "admin_bot_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket" (
    "id" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "organizationId" TEXT,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "requestKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "support_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_message" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_refund_request" (
    "id" TEXT NOT NULL,
    "paymentKey" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEnvironment" TEXT NOT NULL,
    "productKind" "PaymentProductKind" NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "subscriptionId" TEXT,
    "amountMicros" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "providerRequestId" TEXT NOT NULL,
    "providerRefundId" TEXT,
    "reason" TEXT,
    "cancelSubscription" BOOLEAN NOT NULL DEFAULT false,
    "requestedBy" TEXT NOT NULL,
    "processingToken" TEXT,
    "processingLeasedUntil" TIMESTAMPTZ(3),
    "providerAcceptedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_refund_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_service_account_scopeKey_createdAt_idx" ON "admin_service_account"("scopeKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_api_key_keyHash_key" ON "admin_api_key"("keyHash");

-- CreateIndex
CREATE INDEX "admin_api_key_serviceAccountId_createdAt_idx" ON "admin_api_key"("serviceAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_execution_actorId_scopeKey_createdAt_idx" ON "admin_execution"("actorId", "scopeKey", "createdAt");

-- CreateIndex
CREATE INDEX "admin_execution_operation_createdAt_idx" ON "admin_execution"("operation", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_bot_receipt_eventKey_key" ON "admin_bot_receipt"("eventKey");

-- CreateIndex
CREATE INDEX "support_ticket_createdByUserId_updatedAt_idx" ON "support_ticket"("createdByUserId", "updatedAt");

-- CreateIndex
CREATE INDEX "support_ticket_organizationId_updatedAt_idx" ON "support_ticket"("organizationId", "updatedAt");

-- CreateIndex
CREATE INDEX "support_ticket_status_updatedAt_idx" ON "support_ticket"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_createdByUserId_requestKey_key" ON "support_ticket"("createdByUserId", "requestKey");

-- CreateIndex
CREATE INDEX "support_ticket_message_ticketId_createdAt_idx" ON "support_ticket_message"("ticketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_message_ticketId_requestKey_key" ON "support_ticket_message"("ticketId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "admin_refund_request_paymentKey_key" ON "admin_refund_request"("paymentKey");

-- CreateIndex
CREATE UNIQUE INDEX "admin_refund_request_providerRequestId_key" ON "admin_refund_request"("providerRequestId");

-- CreateIndex
CREATE INDEX "admin_refund_request_ownerType_ownerId_createdAt_idx" ON "admin_refund_request"("ownerType", "ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_refund_request_status_updatedAt_idx" ON "admin_refund_request"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "admin_api_key" ADD CONSTRAINT "admin_api_key_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "admin_service_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_message" ADD CONSTRAINT "support_ticket_message_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
