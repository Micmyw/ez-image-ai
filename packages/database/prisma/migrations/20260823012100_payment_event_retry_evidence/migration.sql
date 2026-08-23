ALTER TABLE "payment_event"
  ADD COLUMN "lastTriggerAttempt" INTEGER,
  ADD COLUMN "lastAttemptAt" TIMESTAMPTZ(3);
