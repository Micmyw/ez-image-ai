-- PaymentEvent receipts are deduplicated only by Stripe event ID. Several events may describe
-- one invoice/refund, so normalized transaction IDs remain lookup indexes rather than uniqueness
-- boundaries.
BEGIN;

DROP INDEX IF EXISTS "payment_event_normalized_transaction_id_key";
DROP INDEX IF EXISTS "payment_event_provider_normalizedTransactionId_key";

CREATE TYPE "StripeRefundStatus" AS ENUM (
  'PENDING',
  'REQUIRES_ACTION',
  'SUCCEEDED',
  'FAILED',
  'CANCELED'
);

CREATE TYPE "StripeReconciliationStatus" AS ENUM ('IDLE', 'RUNNING');
CREATE TYPE "StripeReconciliationStage" AS ENUM ('SUBSCRIPTIONS', 'INVOICES', 'REFUNDS');
CREATE TYPE "StripeReconciliationIssueStatus" AS ENUM ('OPEN', 'RESOLVED');

ALTER TABLE "billing_period"
  ADD COLUMN "providerInvoicePaymentId" TEXT,
  ADD COLUMN "providerPaymentIntentId" TEXT;

ALTER TABLE "subscription"
  ADD COLUMN "lastReconciliationSweepId" TEXT,
  ADD COLUMN "lastReconciliationAppliedSweepId" TEXT,
  ADD COLUMN "lastReconciledAt" TIMESTAMPTZ(3);

CREATE TABLE "stripe_refund" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerRefundId" TEXT NOT NULL,
  "providerChargeId" TEXT NOT NULL,
  "providerPaymentIntentId" TEXT,
  "amount" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "status" "StripeRefundStatus" NOT NULL,
  "providerCreatedAt" TIMESTAMPTZ(3) NOT NULL,
  "lastProviderChangeAt" TIMESTAMPTZ(3) NOT NULL,
  "lastProviderChangeId" TEXT NOT NULL,
  "finalizedCredits" BIGINT NOT NULL DEFAULT 0,
  "creditsFinalizedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "stripe_refund_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stripe_refund_amounts_nonnegative"
    CHECK ("amount" >= 0 AND "finalizedCredits" >= 0),
  CONSTRAINT "stripe_refund_finalization_requires_success"
    CHECK (
      ("creditsFinalizedAt" IS NULL OR "status" = 'SUCCEEDED')
      AND
      (
        "finalizedCredits" = 0
        OR ("status" = 'SUCCEEDED' AND "creditsFinalizedAt" IS NOT NULL)
      )
    )
);

CREATE TABLE "stripe_refund_receipt" (
  "id" TEXT NOT NULL,
  "refundId" TEXT NOT NULL,
  "paymentEventId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stripe_refund_receipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stripe_reconciliation_checkpoint" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "status" "StripeReconciliationStatus" NOT NULL DEFAULT 'IDLE',
  "sweepId" TEXT,
  "sweepCutoff" TIMESTAMPTZ(3),
  "stage" "StripeReconciliationStage" NOT NULL DEFAULT 'SUBSCRIPTIONS',
  "cursor" TEXT,
  "leaseToken" TEXT,
  "leasedUntil" TIMESTAMPTZ(3),
  "pagesProcessed" INTEGER NOT NULL DEFAULT 0,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMPTZ(3),
  "lastCompletedAt" TIMESTAMPTZ(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "stripe_reconciliation_checkpoint_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stripe_reconciliation_running_sweep_complete"
    CHECK (
      ("status" = 'IDLE' AND "leaseToken" IS NULL AND "leasedUntil" IS NULL)
      OR
      ("status" = 'RUNNING' AND "sweepId" IS NOT NULL AND "sweepCutoff" IS NOT NULL)
    )
);

CREATE TABLE "stripe_reconciliation_issue" (
  "id" TEXT NOT NULL,
  "issueKey" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "sweepId" TEXT NOT NULL,
  "stage" "StripeReconciliationStage" NOT NULL,
  "code" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "providerObjectId" TEXT NOT NULL,
  "status" "StripeReconciliationIssueStatus" NOT NULL DEFAULT 'OPEN',
  "details" JSONB NOT NULL,
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMPTZ(3),
  CONSTRAINT "stripe_reconciliation_issue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stripe_reconciliation_issue_occurrences_positive" CHECK ("occurrences" > 0)
);

CREATE INDEX "stripe_refund_provider_providerChargeId_status_idx"
  ON "stripe_refund"("provider", "providerChargeId", "status");
CREATE INDEX "stripe_refund_status_creditsFinalizedAt_idx"
  ON "stripe_refund"("status", "creditsFinalizedAt");
CREATE UNIQUE INDEX "stripe_refund_provider_providerRefundId_key"
  ON "stripe_refund"("provider", "providerRefundId");
CREATE UNIQUE INDEX "stripe_refund_receipt_paymentEventId_key"
  ON "stripe_refund_receipt"("paymentEventId");
CREATE INDEX "stripe_refund_receipt_refundId_createdAt_idx"
  ON "stripe_refund_receipt"("refundId", "createdAt");
CREATE UNIQUE INDEX "stripe_refund_receipt_refundId_paymentEventId_key"
  ON "stripe_refund_receipt"("refundId", "paymentEventId");
CREATE UNIQUE INDEX "stripe_reconciliation_checkpoint_provider_key"
  ON "stripe_reconciliation_checkpoint"("provider");
CREATE UNIQUE INDEX "stripe_reconciliation_checkpoint_leaseToken_key"
  ON "stripe_reconciliation_checkpoint"("leaseToken");
CREATE INDEX "stripe_reconciliation_checkpoint_status_leasedUntil_idx"
  ON "stripe_reconciliation_checkpoint"("status", "leasedUntil");
CREATE UNIQUE INDEX "stripe_reconciliation_issue_issueKey_key"
  ON "stripe_reconciliation_issue"("issueKey");
CREATE INDEX "stripe_reconciliation_issue_status_lastSeenAt_idx"
  ON "stripe_reconciliation_issue"("status", "lastSeenAt");
CREATE INDEX "stripe_reconciliation_issue_provider_providerObjectId_idx"
  ON "stripe_reconciliation_issue"("provider", "providerObjectId");
CREATE INDEX "billing_period_providerInvoicePaymentId_idx"
  ON "billing_period"("providerInvoicePaymentId");
CREATE INDEX "billing_period_providerPaymentIntentId_idx"
  ON "billing_period"("providerPaymentIntentId");
CREATE INDEX "subscription_provider_status_createdAt_idx"
  ON "subscription"("provider", "status", "createdAt");
CREATE INDEX "subscription_provider_reconcile_sweep_status_idx"
  ON "subscription"("provider", "lastReconciliationAppliedSweepId", "status");
CREATE INDEX "payment_event_provider_normalizedTransactionId_idx"
  ON "payment_event"("provider", "normalizedTransactionId");

ALTER TABLE "stripe_refund_receipt"
  ADD CONSTRAINT "stripe_refund_receipt_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "stripe_refund"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stripe_refund_receipt"
  ADD CONSTRAINT "stripe_refund_receipt_paymentEventId_fkey"
  FOREIGN KEY ("paymentEventId") REFERENCES "payment_event"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
