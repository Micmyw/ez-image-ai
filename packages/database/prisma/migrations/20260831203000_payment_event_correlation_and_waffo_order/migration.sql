-- AlterTable
ALTER TABLE "payment_checkout_intent" ADD COLUMN "providerOrderId" TEXT;

-- AlterTable
ALTER TABLE "payment_event" ADD COLUMN "providerSubscriptionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "payment_checkout_intent_provider_providerOrderId_key"
ON "payment_checkout_intent"("provider", "providerOrderId");

-- CreateIndex
CREATE INDEX "payment_event_provider_providerSubscriptionId_idx"
ON "payment_event"("provider", "providerSubscriptionId");
