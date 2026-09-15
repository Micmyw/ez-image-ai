CREATE TABLE "subscription_payment_adjustment" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "providerAdjustmentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'REFUND',
    "amountMicros" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "providerCreatedAt" TIMESTAMPTZ(3) NOT NULL,
    "paymentEventId" TEXT,
    "finalizedCredits" BIGINT NOT NULL DEFAULT 0,
    "creditsFinalizedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "subscription_payment_adjustment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_payment_adjustment_amount_check" CHECK ("amountMicros" > 0 AND "finalizedCredits" >= 0),
    CONSTRAINT "subscription_payment_adjustment_kind_check" CHECK ("kind" IN ('REFUND', 'REVERSAL')),
    CONSTRAINT "subscription_payment_adjustment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "subscription_payment_adjustment_provider_adjustment_key" ON "subscription_payment_adjustment"("provider", "providerAdjustmentId");
CREATE INDEX "subscription_payment_adjustment_provider_providerPaymentId_idx" ON "subscription_payment_adjustment"("provider", "providerPaymentId");
CREATE INDEX "subscription_payment_adjustment_subscriptionId_idx" ON "subscription_payment_adjustment"("subscriptionId");
