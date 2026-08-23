-- Repair staged finalizers left by a binary that ran before the terminalization
-- fence. These rows can be reopened to PENDING by the current sweeper, so they
-- need the same one-time terminalization marker as ordinary staged uploads.
UPDATE "media_upload_session"
SET "stagedTerminalizationToken" = md5(
	"id" || ':' || clock_timestamp()::TEXT || ':' || random()::TEXT
)
WHERE "status" = 'FINALIZING'
	AND "stagingObjectKey" IS NOT NULL
	AND "stagedTerminalizationToken" IS NULL;
