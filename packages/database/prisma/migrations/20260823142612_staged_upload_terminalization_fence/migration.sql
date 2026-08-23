-- AlterTable
ALTER TABLE "media_upload_session" ADD COLUMN "stagedTerminalizationToken" TEXT;

-- Every staged session needs an opaque marker before an old binary can write a
-- terminal state. New application code compares this marker in its update
-- predicate and clears it in the same one-time terminal transition.
UPDATE "media_upload_session"
SET "stagedTerminalizationToken" = md5(
	"id" || ':' || clock_timestamp()::TEXT || ':' || random()::TEXT
)
WHERE "status" = 'PENDING'
	AND "stagingObjectKey" IS NOT NULL
	AND "stagedTerminalizationToken" IS NULL;

-- A rolling deployment can leave an old process that still directly changes
-- PENDING staged uploads to a terminal state. Its update retains the marker,
-- so reject it. The new transactional path must consume the marker by setting
-- it to NULL as it changes the status. The marker's presence on OLD prevents a
-- legacy/backfilled row from being terminalized without the new CAS predicate.
CREATE OR REPLACE FUNCTION "media_upload_session_guard_staged_terminalization"()
RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT'
		AND NEW."status" = 'PENDING'
		AND NEW."stagingObjectKey" IS NOT NULL
		AND NEW."stagedTerminalizationToken" IS NULL THEN
		RAISE EXCEPTION 'MEDIA_UPLOAD_STAGED_TERMINALIZATION_TOKEN_REQUIRED'
			USING ERRCODE = 'check_violation';
	END IF;

	IF TG_OP = 'UPDATE'
		AND OLD."status" = 'PENDING'
		AND NEW."status" IN ('COMPLETED', 'ABORTED', 'EXPIRED')
		AND OLD."stagingObjectKey" IS NOT NULL
		AND (
			OLD."stagedTerminalizationToken" IS NULL
			OR NEW."stagedTerminalizationToken" IS NOT NULL
		) THEN
		RAISE EXCEPTION 'MEDIA_UPLOAD_STAGED_TERMINALIZATION_TOKEN_REQUIRED'
			USING ERRCODE = 'check_violation';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "media_upload_session_guard_staged_terminalization"
BEFORE INSERT OR UPDATE OF "status", "stagedTerminalizationToken"
ON "media_upload_session"
FOR EACH ROW EXECUTE FUNCTION "media_upload_session_guard_staged_terminalization"();
