ALTER TABLE "generation_attempt"
  ADD COLUMN "lastProviderOccurredAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastProviderReceivedAt" TIMESTAMPTZ(3);
