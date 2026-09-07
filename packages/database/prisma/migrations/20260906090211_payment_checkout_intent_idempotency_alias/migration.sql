-- CreateTable
CREATE TABLE "payment_checkout_intent_idempotency_alias" (
    "id" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "checkoutIntentId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_checkout_intent_idempotency_alias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_checkout_intent_idempotency_alias_checkoutIntentId_idx" ON "payment_checkout_intent_idempotency_alias"("checkoutIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_checkout_intent_idempotency_alias_ownerType_ownerId_key" ON "payment_checkout_intent_idempotency_alias"("ownerType", "ownerId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "payment_checkout_intent_idempotency_alias" ADD CONSTRAINT "payment_checkout_intent_idempotency_alias_checkoutIntentId_fkey" FOREIGN KEY ("checkoutIntentId") REFERENCES "payment_checkout_intent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
