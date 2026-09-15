CREATE TABLE "payment_reconciliation_checkpoint" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "windowStart" TIMESTAMPTZ(3) NOT NULL,
  "windowEnd" TIMESTAMPTZ(3),
  "cursor" TEXT,
  "leaseToken" TEXT,
  "leasedUntil" TIMESTAMPTZ(3),
  "lastCompletedAt" TIMESTAMPTZ(3),
  "lastError" TEXT,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
