-- AlterTable
ALTER TABLE "media_upload_session"
ADD COLUMN "finalizationLeaseExpiresAt" TIMESTAMPTZ(3);

-- Record the token held by a pre-lease finalizer so the trigger can let that
-- in-flight old worker terminalize during the drain window without allowing a
-- stale old request to abort a later new-token claimant.
ALTER TABLE "media_upload_session"
ADD COLUMN "legacyFinalizationToken" TEXT;

-- CreateIndex
CREATE INDEX "media_upload_session_status_finalizationLeaseExpiresAt_idx"
ON "media_upload_session"("status", "finalizationLeaseExpiresAt");

-- An old pod can still claim a staged session without a lease while a rolling
-- deployment is in progress. Give that claimant a bounded drain window. Its
-- original token may complete only during that window; after that window, let
-- only that same recorded token abort so its old transaction can release the
-- reservation. Once a new claimant replaces the token, reject an old direct
-- FINALIZING -> terminal write.
CREATE OR REPLACE FUNCTION "media_upload_session_guard_finalization_lease"()
RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'UPDATE'
		AND OLD."status" = 'FINALIZING'
		AND NEW."status" = 'COMPLETED' THEN
		IF NEW."finalizationToken" IS NULL
			AND NEW."finalizationLeaseExpiresAt" IS NULL THEN
			NEW."legacyFinalizationToken" = NULL;
		ELSIF OLD."legacyFinalizationToken" IS NOT NULL
			AND OLD."finalizationToken" = OLD."legacyFinalizationToken"
			AND OLD."finalizationLeaseExpiresAt" > CURRENT_TIMESTAMP THEN
			NEW."finalizationToken" = NULL;
			NEW."legacyFinalizationToken" = NULL;
			NEW."finalizationLeaseExpiresAt" = NULL;
		ELSE
			RAISE EXCEPTION 'MEDIA_UPLOAD_FINALIZATION_TOKEN_REQUIRED' USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	IF TG_OP = 'UPDATE'
		AND OLD."status" = 'FINALIZING'
		AND NEW."status" = 'ABORTED' THEN
		IF OLD."legacyFinalizationToken" IS NOT NULL
			AND OLD."finalizationToken" = OLD."legacyFinalizationToken" THEN
			NEW."finalizationToken" = NULL;
			NEW."legacyFinalizationToken" = NULL;
			NEW."finalizationLeaseExpiresAt" = NULL;
		ELSIF NEW."finalizationToken" IS NOT NULL THEN
			RAISE EXCEPTION 'MEDIA_UPLOAD_FINALIZATION_TOKEN_REQUIRED' USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	IF TG_OP = 'UPDATE'
		AND OLD."status" = 'FINALIZING'
		AND NEW."status" = 'FINALIZING'
		AND OLD."legacyFinalizationToken" IS NOT NULL
		AND NEW."finalizationToken" IS DISTINCT FROM OLD."legacyFinalizationToken" THEN
		NEW."legacyFinalizationToken" = NULL;
	END IF;
	IF NEW."status" = 'FINALIZING'
		AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'FINALIZING')
		AND NEW."finalizationLeaseExpiresAt" IS NULL THEN
		NEW."finalizationLeaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '30 minutes';
		NEW."legacyFinalizationToken" = NEW."finalizationToken";
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "media_upload_session_guard_finalization_lease"
BEFORE INSERT OR UPDATE OF "status", "finalizationToken", "finalizationLeaseExpiresAt"
ON "media_upload_session"
FOR EACH ROW EXECUTE FUNCTION "media_upload_session_guard_finalization_lease"();

-- Existing old-code claimants receive the same drain window. Deployments still need
-- to drain old application pods before this guard lease can expire.
UPDATE "media_upload_session"
SET
	"finalizationLeaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '30 minutes',
	"legacyFinalizationToken" = "finalizationToken"
WHERE "status" = 'FINALIZING' AND "finalizationLeaseExpiresAt" IS NULL;
