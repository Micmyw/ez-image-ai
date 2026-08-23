-- A pre-fence finalizer may already have reopened a staged row to PENDING
-- before the finalizer repair ran. Backfill any remaining staged pending rows
-- so the terminal transition always has an opaque compare-and-clear marker.
UPDATE "media_upload_session"
SET "stagedTerminalizationToken" = md5(
	"id" || ':' || clock_timestamp()::TEXT || ':' || random()::TEXT
)
WHERE "status" = 'PENDING'
	AND "stagingObjectKey" IS NOT NULL
	AND "stagedTerminalizationToken" IS NULL;
