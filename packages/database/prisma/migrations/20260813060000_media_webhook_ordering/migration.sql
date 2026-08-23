ALTER TABLE "generation_attempt"
  ADD COLUMN "lastProviderSequence" BIGINT;

ALTER TABLE "provider_webhook_event"
  ADD COLUMN "providerOccurredAt" TIMESTAMPTZ(3),
  ADD COLUMN "providerSequence" BIGINT,
  ADD COLUMN "processingToken" TEXT,
  ADD COLUMN "processingLeasedUntil" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "provider_webhook_event_processingToken_key"
  ON "provider_webhook_event"("processingToken");
CREATE INDEX "provider_webhook_event_processingLeasedUntil_idx"
  ON "provider_webhook_event"("processingLeasedUntil");
