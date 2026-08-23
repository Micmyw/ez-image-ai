ALTER TABLE "generation_job"
  ADD COLUMN "finalizationStage" TEXT,
  ADD COLUMN "finalizationRetryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "finalizationErrorCode" TEXT,
  ADD COLUMN "nextFinalizeAt" TIMESTAMPTZ(3);

CREATE INDEX "generation_job_status_nextFinalizeAt_idx"
  ON "generation_job"("status", "nextFinalizeAt");
