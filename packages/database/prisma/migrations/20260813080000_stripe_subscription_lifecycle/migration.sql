ALTER TABLE "billing_plan" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "subscription"
  ADD COLUMN "scheduledPlanId" TEXT,
  ADD COLUMN "lastProviderEventAt" TIMESTAMPTZ(3);

ALTER TABLE "billing_period"
  ADD COLUMN "providerInvoiceId" TEXT,
  ADD COLUMN "providerChargeId" TEXT,
  ADD COLUMN "paidAmount" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "refundedAmount" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "refundedCredits" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "payment_event"
  ADD COLUMN "processingToken" TEXT,
  ADD COLUMN "processingLeasedUntil" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "payment_event_processingToken_key" ON "payment_event"("processingToken");
CREATE UNIQUE INDEX "payment_event_provider_normalizedTransactionId_key"
  ON "payment_event"("provider", "normalizedTransactionId")
  WHERE "normalizedTransactionId" IS NOT NULL AND "normalizedTransactionId" <> '';
CREATE INDEX "payment_event_processingLeasedUntil_idx" ON "payment_event"("processingLeasedUntil");
CREATE INDEX "billing_period_providerInvoiceId_idx" ON "billing_period"("providerInvoiceId");
CREATE INDEX "billing_period_providerChargeId_idx" ON "billing_period"("providerChargeId");

ALTER TABLE "billing_period" ADD CONSTRAINT "billing_period_refunds_bounded"
  CHECK ("paidAmount" >= 0 AND "refundedAmount" >= 0 AND "refundedCredits" >= 0
    AND "refundedAmount" <= "paidAmount" AND "refundedCredits" <= "creditAmount");
