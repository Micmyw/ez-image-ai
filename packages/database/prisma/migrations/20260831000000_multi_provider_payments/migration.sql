-- CreateEnum
CREATE TYPE "PaymentCheckoutIntentStatus" AS ENUM ('CREATED', 'PROVIDER_PENDING', 'COMPLETED', 'EXPIRED', 'CANCELED', 'REVIEW');

-- Preserve existing Stripe purchases while allowing provider-scoped subscription identities.
ALTER TABLE "purchase" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'stripe';
DROP INDEX "purchase_subscriptionId_key";
DROP INDEX "subscription_providerSubscriptionId_key";

-- CreateTable
CREATE TABLE "payment_customer" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "providerCustomerId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_checkout_intent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "billingPlanId" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerSessionId" TEXT,
    "activeScopeKey" TEXT,
    "status" "PaymentCheckoutIntentStatus" NOT NULL DEFAULT 'CREATED',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_checkout_intent_pkey" PRIMARY KEY ("id")
);

-- Backfill legacy Stripe customer mappings without removing the compatibility columns.
INSERT INTO "payment_customer" (
    "id", "provider", "ownerType", "ownerId", "providerCustomerId", "createdAt", "updatedAt"
)
SELECT
    'legacy_stripe_user_' || md5("id"),
    'stripe',
    'USER'::"OwnerType",
    "id",
    "paymentsCustomerId",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "user"
WHERE "paymentsCustomerId" IS NOT NULL AND btrim("paymentsCustomerId") <> ''
ON CONFLICT DO NOTHING;

INSERT INTO "payment_customer" (
    "id", "provider", "ownerType", "ownerId", "providerCustomerId", "createdAt", "updatedAt"
)
SELECT
    'legacy_stripe_org_' || md5("id"),
    'stripe',
    'ORGANIZATION'::"OwnerType",
    "id",
    "paymentsCustomerId",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "organization"
WHERE "paymentsCustomerId" IS NOT NULL AND btrim("paymentsCustomerId") <> ''
ON CONFLICT DO NOTHING;

-- CreateIndex
CREATE INDEX "payment_customer_provider_providerCustomerId_idx" ON "payment_customer"("provider", "providerCustomerId");
CREATE UNIQUE INDEX "payment_customer_provider_ownerType_ownerId_key" ON "payment_customer"("provider", "ownerType", "ownerId");
CREATE UNIQUE INDEX "payment_checkout_intent_activeScopeKey_key" ON "payment_checkout_intent"("activeScopeKey");
CREATE INDEX "payment_checkout_intent_ownerType_ownerId_planKey_interval__idx" ON "payment_checkout_intent"("ownerType", "ownerId", "planKey", "interval", "status");
CREATE INDEX "payment_checkout_intent_expiresAt_status_idx" ON "payment_checkout_intent"("expiresAt", "status");
CREATE UNIQUE INDEX "payment_checkout_intent_provider_ownerType_ownerId_idempote_key" ON "payment_checkout_intent"("provider", "ownerType", "ownerId", "idempotencyKey");
CREATE UNIQUE INDEX "payment_checkout_intent_provider_providerSessionId_key" ON "payment_checkout_intent"("provider", "providerSessionId");
CREATE UNIQUE INDEX "purchase_provider_subscriptionId_key" ON "purchase"("provider", "subscriptionId");
CREATE UNIQUE INDEX "subscription_provider_providerSubscriptionId_key" ON "subscription"("provider", "providerSubscriptionId");

-- AddForeignKey
ALTER TABLE "payment_checkout_intent" ADD CONSTRAINT "payment_checkout_intent_billingPlanId_fkey" FOREIGN KEY ("billingPlanId") REFERENCES "billing_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
