-- AlterEnum
ALTER TYPE "PaymentCheckoutIntentStatus" ADD VALUE 'PROVIDER_CREATING';

-- DropIndex
DROP INDEX "payment_checkout_intent_provider_ownerType_ownerId_idempote_key";

-- AlterTable
ALTER TABLE "payment_checkout_intent"
ADD COLUMN "providerCheckoutUrl" TEXT,
ALTER COLUMN "expiresAt" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "payment_checkout_intent_ownerType_ownerId_idempotencyKey_key"
ON "payment_checkout_intent"("ownerType", "ownerId", "idempotencyKey");
