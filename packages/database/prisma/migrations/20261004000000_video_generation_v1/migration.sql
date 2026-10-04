-- CreateEnum
CREATE TYPE "VideoExecutionStartState" AS ENUM ('PENDING', 'STARTED', 'FAILED');

-- CreateEnum
CREATE TYPE "VideoExecutionStage" AS ENUM ('QUEUED', 'INPUT_REVIEW', 'SUBMITTING', 'SUBMISSION_UNCERTAIN', 'GENERATING', 'STORING', 'OUTPUT_REVIEW', 'FINALIZING', 'READY', 'REJECTED', 'FAILED', 'NEEDS_REVIEW');

-- AlterTable
ALTER TABLE "generation_job" ADD COLUMN     "executionEngine" TEXT NOT NULL DEFAULT 'legacy';

-- AlterTable
ALTER TABLE "generation_attempt" ADD COLUMN     "callbackTokenHash" TEXT;

-- AlterTable
ALTER TABLE "media_asset" ADD COLUMN     "verificationEngine" TEXT NOT NULL DEFAULT 'legacy';

-- CreateTable
CREATE TABLE "video_execution" (
    "jobId" TEXT NOT NULL,
    "workflowInstanceId" TEXT NOT NULL,
    "workflowSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "startState" "VideoExecutionStartState" NOT NULL DEFAULT 'PENDING',
    "stage" "VideoExecutionStage" NOT NULL DEFAULT 'QUEUED',
    "modelContractVersion" TEXT NOT NULL,
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "startAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextStartAt" TIMESTAMPTZ(3),
    "lastProgressAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "needsReviewReason" TEXT,
    "providerDeadlineAt" TIMESTAMPTZ(3),
    "providerPollRound" INTEGER NOT NULL DEFAULT 0,
    "inputReviewDeadlineAt" TIMESTAMPTZ(3),
    "outputReviewDeadlineAt" TIMESTAMPTZ(3),
    "inputReviewRound" INTEGER NOT NULL DEFAULT 0,
    "outputReviewRound" INTEGER NOT NULL DEFAULT 0,
    "stageData" JSONB NOT NULL DEFAULT '{}',
    "queuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inputReviewStartedAt" TIMESTAMPTZ(3),
    "inputReviewCompletedAt" TIMESTAMPTZ(3),
    "providerSubmitStartedAt" TIMESTAMPTZ(3),
    "providerAcceptedAt" TIMESTAMPTZ(3),
    "providerCompletedAt" TIMESTAMPTZ(3),
    "storageStartedAt" TIMESTAMPTZ(3),
    "storageCompletedAt" TIMESTAMPTZ(3),
    "outputReviewStartedAt" TIMESTAMPTZ(3),
    "outputReviewCompletedAt" TIMESTAMPTZ(3),
    "finalizationStartedAt" TIMESTAMPTZ(3),
    "readyAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "video_execution_pkey" PRIMARY KEY ("jobId")
);

-- CreateIndex
CREATE UNIQUE INDEX "video_execution_workflowInstanceId_key" ON "video_execution"("workflowInstanceId");

-- CreateIndex
CREATE INDEX "video_execution_startState_nextStartAt_jobId_idx" ON "video_execution"("startState", "nextStartAt", "jobId");

-- CreateIndex
CREATE INDEX "video_execution_stage_lastProgressAt_jobId_idx" ON "video_execution"("stage", "lastProgressAt", "jobId");

-- CreateIndex
CREATE INDEX "generation_job_executionEngine_status_updatedAt_id_idx" ON "generation_job"("executionEngine", "status", "updatedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "generation_attempt_callbackTokenHash_key" ON "generation_attempt"("callbackTokenHash");

-- CreateIndex
CREATE INDEX "media_asset_verificationEngine_status_verificationNextAttem_idx" ON "media_asset"("verificationEngine", "status", "verificationNextAttemptAt");

-- AddForeignKey
ALTER TABLE "video_execution" ADD CONSTRAINT "video_execution_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "generation_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ownership is permanent. Neither recovery nor an old runtime may silently adopt a task.
ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_execution_engine_check"
 CHECK ("executionEngine" IN ('legacy', 'video-workflow-v1'));
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_verification_engine_check"
 CHECK ("verificationEngine" IN ('legacy', 'video-workflow-v1'));
ALTER TABLE "video_execution" ADD CONSTRAINT "video_execution_version_check"
 CHECK ("workflowSchemaVersion" = 1 AND "stateVersion" >= 0 AND "startAttemptCount" >= 0
 AND "providerPollRound" >= 0 AND "inputReviewRound" >= 0 AND "outputReviewRound" >= 0
 AND "workflowInstanceId" = 'video-v1-' || "jobId");

CREATE FUNCTION "guard_generation_execution_engine"() RETURNS trigger AS $$
BEGIN
 IF NEW."executionEngine" IS DISTINCT FROM OLD."executionEngine" THEN
  RAISE EXCEPTION 'Generation execution engine is immutable';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "generation_job_execution_engine_immutable" BEFORE UPDATE ON "generation_job"
 FOR EACH ROW EXECUTE FUNCTION "guard_generation_execution_engine"();

CREATE FUNCTION "guard_asset_verification_engine"() RETURNS trigger AS $$
BEGIN
 IF NEW."verificationEngine" IS DISTINCT FROM OLD."verificationEngine" THEN
  RAISE EXCEPTION 'Asset verification engine is immutable';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "media_asset_verification_engine_immutable" BEFORE UPDATE ON "media_asset"
 FOR EACH ROW EXECUTE FUNCTION "guard_asset_verification_engine"();

CREATE FUNCTION "guard_video_execution_owner"() RETURNS trigger AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "generation_job" WHERE "id" = NEW."jobId"
  AND "executionEngine" = 'video-workflow-v1') THEN
  RAISE EXCEPTION 'Video execution requires video-owned generation job';
 END IF;
 IF TG_OP = 'UPDATE' AND (NEW."jobId" IS DISTINCT FROM OLD."jobId"
  OR NEW."workflowInstanceId" IS DISTINCT FROM OLD."workflowInstanceId"
  OR NEW."workflowSchemaVersion" IS DISTINCT FROM OLD."workflowSchemaVersion") THEN
  RAISE EXCEPTION 'Video workflow identity is immutable';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "video_execution_owner" BEFORE INSERT OR UPDATE ON "video_execution"
 FOR EACH ROW EXECUTE FUNCTION "guard_video_execution_owner"();
REVOKE ALL ON FUNCTION "guard_generation_execution_engine"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "guard_asset_verification_engine"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "guard_video_execution_owner"() FROM PUBLIC;

-- Better Auth identities are not Supabase auth.uid(). This is server-only data.
ALTER TABLE "video_execution" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "video_execution" FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ezpic_app') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON "video_execution" TO ezpic_app;
  CREATE POLICY video_execution_app ON "video_execution" TO ezpic_app USING (true) WITH CHECK (true);
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  REVOKE ALL ON "video_execution" FROM anon;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  REVOKE ALL ON "video_execution" FROM authenticated;
 END IF;
END $$;
