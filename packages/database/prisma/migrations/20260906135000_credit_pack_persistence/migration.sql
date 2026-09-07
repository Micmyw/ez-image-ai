-- CreateEnum
CREATE TYPE "PaymentProductKind" AS ENUM ('PLAN', 'CREDIT_PACK');

-- CreateEnum
CREATE TYPE "CreditPackFulfillmentStatus" AS ENUM ('FULFILLED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "CreditPackAdjustmentStatus" AS ENUM ('PENDING', 'REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- AlterTable
ALTER TABLE "billing_plan" ADD COLUMN "productKind" "PaymentProductKind" NOT NULL DEFAULT 'PLAN';

-- AlterTable
ALTER TABLE "payment_checkout_intent"
ADD COLUMN "creditPackBaseCredits" BIGINT,
ADD COLUMN "creditPackBonusCredits" BIGINT,
ADD COLUMN "creditPackCatalogVersion" TEXT,
ADD COLUMN "creditPackEligibilityEvaluatedAt" TIMESTAMPTZ(3),
ADD COLUMN "creditPackExpiryMonths" INTEGER,
ADD COLUMN "creditPackPricingVersion" TEXT,
ADD COLUMN "creditPackSubscriberBonusEligible" BOOLEAN,
ADD COLUMN "creditPackSubscriberEligibilityVersion" TEXT,
ADD COLUMN "creditPackSubscriberPlanKey" TEXT,
ADD COLUMN "creditPackSubscriberSubscriptionId" TEXT,
ADD COLUMN "creditPackTotalCredits" BIGINT,
ADD COLUMN "productKind" "PaymentProductKind" NOT NULL DEFAULT 'PLAN';

-- Existing PLAN intents deliberately retain the legacy
-- ownerType:ownerId:planKey:interval active scope. New PLAN writers use the
-- same key during rolling deployments, while CREDIT_PACK writers use a
-- product-kind-qualified key. No data rewrite means this migration cannot
-- create a unique-key collision or split one PLAN checkout into two scopes.

-- AlterTable
ALTER TABLE "purchase" ADD COLUMN "productKind" "PaymentProductKind" NOT NULL DEFAULT 'PLAN';

-- CreateTable
CREATE TABLE "credit_pack_fulfillment" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT,
    "checkoutIntentId" TEXT NOT NULL,
    "billingPlanId" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerOrderId" TEXT NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "paidAmountMicros" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "baseCredits" BIGINT NOT NULL,
    "bonusCredits" BIGINT NOT NULL,
    "grantedCredits" BIGINT NOT NULL,
    "refundedAmountMicros" BIGINT NOT NULL DEFAULT 0,
    "refundedCredits" BIGINT NOT NULL DEFAULT 0,
    "grantReferenceKey" TEXT NOT NULL,
    "paidAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "CreditPackFulfillmentStatus" NOT NULL DEFAULT 'FULFILLED',
    "fulfilledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credit_pack_fulfillment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_pack_adjustment" (
    "id" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAdjustmentId" TEXT NOT NULL,
    "amountMicros" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "CreditPackAdjustmentStatus" NOT NULL,
    "providerCreatedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastProviderChangeAt" TIMESTAMPTZ(3) NOT NULL,
    "lastProviderChangeId" TEXT NOT NULL,
    "finalizedCredits" BIGINT NOT NULL DEFAULT 0,
    "creditsFinalizedAt" TIMESTAMPTZ(3),
    "refundReferenceKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credit_pack_adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_pack_fulfillment_purchaseId_key" ON "credit_pack_fulfillment"("purchaseId");
CREATE UNIQUE INDEX "credit_pack_fulfillment_checkoutIntentId_key" ON "credit_pack_fulfillment"("checkoutIntentId");
CREATE UNIQUE INDEX "credit_pack_fulfillment_grantReferenceKey_key" ON "credit_pack_fulfillment"("grantReferenceKey");
CREATE UNIQUE INDEX "credit_pack_fulfillment_provider_providerOrderId_key" ON "credit_pack_fulfillment"("provider", "providerOrderId");
CREATE INDEX "credit_pack_fulfillment_ownerType_ownerId_fulfilledAt_id_idx" ON "credit_pack_fulfillment"("ownerType", "ownerId", "fulfilledAt", "id");
CREATE INDEX "credit_pack_fulfillment_status_fulfilledAt_idx" ON "credit_pack_fulfillment"("status", "fulfilledAt");
CREATE INDEX "credit_pack_fulfillment_expiresAt_idx" ON "credit_pack_fulfillment"("expiresAt");
CREATE UNIQUE INDEX "credit_pack_fulfillment_provider_providerPaymentId_key" ON "credit_pack_fulfillment"("provider", "providerPaymentId");
CREATE UNIQUE INDEX "credit_pack_adjustment_refundReferenceKey_key" ON "credit_pack_adjustment"("refundReferenceKey");
CREATE INDEX "credit_pack_adjustment_fulfillmentId_status_idx" ON "credit_pack_adjustment"("fulfillmentId", "status");
CREATE INDEX "credit_pack_adjustment_status_creditsFinalizedAt_idx" ON "credit_pack_adjustment"("status", "creditsFinalizedAt");
CREATE UNIQUE INDEX "credit_pack_adjustment_provider_providerAdjustmentId_key" ON "credit_pack_adjustment"("provider", "providerAdjustmentId");

-- AddForeignKey
ALTER TABLE "credit_pack_fulfillment" ADD CONSTRAINT "credit_pack_fulfillment_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "credit_pack_fulfillment" ADD CONSTRAINT "credit_pack_fulfillment_checkoutIntentId_fkey" FOREIGN KEY ("checkoutIntentId") REFERENCES "payment_checkout_intent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_pack_fulfillment" ADD CONSTRAINT "credit_pack_fulfillment_billingPlanId_fkey" FOREIGN KEY ("billingPlanId") REFERENCES "billing_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_pack_adjustment" ADD CONSTRAINT "credit_pack_adjustment_fulfillmentId_fkey" FOREIGN KEY ("fulfillmentId") REFERENCES "credit_pack_fulfillment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "billing_plan" ADD CONSTRAINT "billing_plan_credit_pack_provider" CHECK (
    "productKind" = 'PLAN' OR "provider" IN ('paypal', 'waffo')
);

ALTER TABLE "purchase" ADD CONSTRAINT "purchase_credit_pack_shape" CHECK (
    "productKind" = 'PLAN' OR (
        "provider" IN ('paypal', 'waffo')
        AND "type" = 'ONE_TIME'
        AND "subscriptionId" IS NULL
    )
);

ALTER TABLE "payment_checkout_intent" ADD CONSTRAINT "payment_checkout_intent_credit_pack_snapshot" CHECK (
    (
        "productKind" = 'PLAN'
        AND "creditPackCatalogVersion" IS NULL
        AND "creditPackPricingVersion" IS NULL
        AND "creditPackSubscriberEligibilityVersion" IS NULL
        AND "creditPackBaseCredits" IS NULL
        AND "creditPackBonusCredits" IS NULL
        AND "creditPackTotalCredits" IS NULL
        AND "creditPackExpiryMonths" IS NULL
        AND "creditPackSubscriberBonusEligible" IS NULL
        AND "creditPackSubscriberSubscriptionId" IS NULL
        AND "creditPackSubscriberPlanKey" IS NULL
        AND "creditPackEligibilityEvaluatedAt" IS NULL
    ) OR (
        "productKind" = 'CREDIT_PACK'
        AND "provider" IN ('paypal', 'waffo')
        AND "interval" = 'one-time'
        AND NULLIF("creditPackCatalogVersion", '') IS NOT NULL
        AND NULLIF("creditPackPricingVersion", '') IS NOT NULL
        AND NULLIF("creditPackSubscriberEligibilityVersion", '') IS NOT NULL
        AND "creditPackBaseCredits" > 0
        AND "creditPackBonusCredits" >= 0
        AND "creditPackTotalCredits" = "creditPackBaseCredits" + "creditPackBonusCredits"
        AND "creditPackExpiryMonths" = 6
        AND "creditPackSubscriberBonusEligible" IS NOT NULL
        AND "creditPackEligibilityEvaluatedAt" IS NOT NULL
        AND (
            (
                "creditPackSubscriberBonusEligible" = FALSE
                AND "creditPackBonusCredits" = 0
                AND "creditPackSubscriberSubscriptionId" IS NULL
                AND "creditPackSubscriberPlanKey" IS NULL
            ) OR (
                "creditPackSubscriberBonusEligible" = TRUE
                AND "creditPackBonusCredits" > 0
                AND NULLIF("creditPackSubscriberSubscriptionId", '') IS NOT NULL
                AND NULLIF("creditPackSubscriberPlanKey", '') IS NOT NULL
            )
        )
    )
);

ALTER TABLE "credit_pack_fulfillment" ADD CONSTRAINT "credit_pack_fulfillment_values" CHECK (
    "provider" IN ('paypal', 'waffo')
    AND "paidAmountMicros" > 0
    AND "baseCredits" > 0
    AND "bonusCredits" >= 0
    AND "grantedCredits" = "baseCredits" + "bonusCredits"
    AND "refundedAmountMicros" >= 0
    AND "refundedAmountMicros" <= "paidAmountMicros"
    AND "refundedCredits" >= 0
    AND "refundedCredits" <= "grantedCredits"
    AND "expiresAt" > "paidAt"
);

ALTER TABLE "credit_pack_fulfillment" ADD CONSTRAINT "credit_pack_fulfillment_status_totals" CHECK (
    ("status" = 'FULFILLED' AND "refundedAmountMicros" = 0)
    OR ("status" = 'PARTIALLY_REFUNDED' AND "refundedAmountMicros" > 0 AND "refundedAmountMicros" < "paidAmountMicros")
    OR ("status" = 'REFUNDED' AND "refundedAmountMicros" = "paidAmountMicros")
);

ALTER TABLE "credit_pack_adjustment" ADD CONSTRAINT "credit_pack_adjustment_values" CHECK (
    "provider" IN ('paypal', 'waffo')
    AND "amountMicros" > 0
    AND "finalizedCredits" >= 0
    AND (
        (
            "status" = 'SUCCEEDED'
            AND (
                ("creditsFinalizedAt" IS NULL AND "finalizedCredits" = 0 AND "refundReferenceKey" IS NULL)
                OR ("creditsFinalizedAt" IS NOT NULL AND "refundReferenceKey" IS NOT NULL)
            )
        ) OR (
            "status" <> 'SUCCEEDED'
            AND "creditsFinalizedAt" IS NULL
            AND "finalizedCredits" = 0
            AND "refundReferenceKey" IS NULL
        )
    )
);
