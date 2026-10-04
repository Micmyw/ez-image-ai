-- The accepted video request includes its complete visual-safety provider/profile.
-- Keep that contract fixed for callbacks, recovery and final authorization even
-- when the deployment's defaults change. Existing snapshots remain untouched.
CREATE FUNCTION "guard_video_job_input_snapshot"() RETURNS trigger AS $$
BEGIN
 IF OLD."executionEngine" = 'video-workflow-v1'
    AND NEW."inputSnapshot" IS DISTINCT FROM OLD."inputSnapshot" THEN
  RAISE EXCEPTION 'Video generation input snapshot is immutable' USING ERRCODE = '55000';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "generation_job_video_input_snapshot_immutable"
 BEFORE UPDATE OF "inputSnapshot" ON "generation_job"
 FOR EACH ROW EXECUTE FUNCTION "guard_video_job_input_snapshot"();

REVOKE ALL ON FUNCTION "guard_video_job_input_snapshot"() FROM PUBLIC;
