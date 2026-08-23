ALTER TYPE "EventProcessingStatus" ADD VALUE IF NOT EXISTS 'IGNORED';
ALTER TYPE "EventProcessingStatus" ADD VALUE IF NOT EXISTS 'DEAD_LETTER';

ALTER TABLE "payment_event"
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastTriggerRunId" TEXT,
  ADD COLUMN "lastErrorClass" TEXT;

ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_exactly_one_owner"
  CHECK (num_nonnulls("organizationId", "userId") = 1) NOT VALID;
