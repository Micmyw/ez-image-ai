ALTER TYPE "GenerationJobStatus" ADD VALUE IF NOT EXISTS 'SUBMITTING' AFTER 'DISPATCH_QUEUED';
ALTER TYPE "GenerationJobStatus" ADD VALUE IF NOT EXISTS 'FINALIZING' AFTER 'PROVIDER_RUNNING';

ALTER TABLE "generation_attempt"
  ADD COLUMN "progress" INTEGER,
  ADD COLUMN "lastProviderEventAt" TIMESTAMPTZ(3),
  ADD COLUMN "uncertainSubmission" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reconciliationCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextReconcileAt" TIMESTAMPTZ(3),
  ADD COLUMN "reconcileLeaseToken" TEXT,
  ADD COLUMN "reconcileLeasedUntil" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "generation_attempt_reconcileLeaseToken_key"
  ON "generation_attempt"("reconcileLeaseToken");
CREATE INDEX "generation_attempt_status_nextReconcileAt_updatedAt_idx"
  ON "generation_attempt"("status", "nextReconcileAt", "updatedAt");
