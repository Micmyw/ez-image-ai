-- Stop an old direct-to-final application binary from creating new unsafe sessions
-- while this migration is rolling out. Its request receives a database error, and its
-- existing multipart cleanup path aborts the upload it created before the transaction.
CREATE OR REPLACE FUNCTION "media_upload_session_require_staging_key"()
RETURNS trigger AS $$
BEGIN
	IF NEW."status" IN ('PENDING', 'FINALIZING') AND NEW."stagingObjectKey" IS NULL THEN
		RAISE EXCEPTION 'MEDIA_UPLOAD_STAGING_KEY_REQUIRED' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "media_upload_session_require_staging_key"
BEFORE INSERT OR UPDATE OF "status", "stagingObjectKey" ON "media_upload_session"
FOR EACH ROW EXECUTE FUNCTION "media_upload_session_require_staging_key"();

-- Sessions created before immutable staging wrote directly to the final key. They
-- cannot be safely promoted after this deployment, so retire them and defer physical
-- cleanup until every previously issued ten-minute write URL has expired. This also
-- backstops already terminal sessions: an old immediate cleanup can finish before a
-- still-valid direct-final URL is replayed. Completed legacy assets stay private and
-- quarantined until the delayed, explicitly fenced server-side re-verification path
-- establishes fresh metadata and a SHA-256 fingerprint.
-- MEDIA_UPLOAD_CLEANUP and MEDIA_ASSET_LEGACY_REVERIFY are intentionally new outbox
-- event types: an old dispatcher fails them closed instead of consuming fields it cannot
-- honor. Deploy the new jobs worker before applying this migration.
WITH legacy_sessions AS (
	UPDATE "media_upload_session"
	SET "status" = 'EXPIRED'
	WHERE "stagingObjectKey" IS NULL AND "status" IN ('PENDING', 'FINALIZING')
	RETURNING
		"id",
		"assetId",
		"expiresAt",
		"multipartUploadId",
		'EXPIRED'::TEXT AS "reservationStatus"
), legacy_terminal_sessions AS (
	SELECT
		session."id",
		session."assetId",
		session."expiresAt",
		session."multipartUploadId",
		CASE session."status"
			WHEN 'ABORTED' THEN 'RELEASED'::TEXT
			ELSE 'EXPIRED'::TEXT
		END AS "reservationStatus"
	FROM "media_upload_session" AS session
	WHERE session."stagingObjectKey" IS NULL
		AND session."status" IN ('ABORTED', 'EXPIRED')
), legacy_retired_sessions AS (
	SELECT * FROM legacy_sessions
	UNION ALL
	SELECT * FROM legacy_terminal_sessions
), retired_assets AS (
	UPDATE "media_asset" AS asset
	SET "status" = 'DELETED', "deletedAt" = COALESCE(asset."deletedAt", CURRENT_TIMESTAMP)
	FROM legacy_retired_sessions
	WHERE asset."id" = legacy_retired_sessions."assetId" AND asset."status" <> 'DELETED'
	RETURNING asset."id"
), quarantined_completed_assets AS (
	UPDATE "media_asset" AS asset
	SET
		"status" = 'QUARANTINED',
		"checksum" = NULL,
		"storageEtag" = NULL,
		"storageVersionId" = NULL
	WHERE asset."finalizedAt" IS NULL
		AND asset."status" <> 'DELETED'
	AND EXISTS (
			SELECT 1
			FROM "media_upload_session" AS session
		WHERE session."assetId" = asset."id" AND session."status" = 'COMPLETED'
	)
	AND NOT EXISTS (
		SELECT 1
		FROM "asset_moderation_result" AS moderation
		WHERE moderation."assetId" = asset."id" AND moderation."status" IN ('REJECTED', 'REVIEW')
	)
	RETURNING asset."id"
)
INSERT INTO "outbox_event" (
	"id",
	"eventType",
	"aggregateType",
	"aggregateId",
	"dedupeKey",
	"payload",
	"availableAt"
)
SELECT
	CONCAT('legacy-upload-delete-cleanup:', legacy_retired_sessions."id"),
	'MEDIA_UPLOAD_CLEANUP',
	'MEDIA_ASSET',
	legacy_retired_sessions."assetId",
	CONCAT('media-upload-legacy-delete-cleanup:', legacy_retired_sessions."id"),
	jsonb_build_object(
		'assetId', legacy_retired_sessions."assetId",
		'objectKey', asset."objectKey",
		'uploadSessionId', legacy_retired_sessions."id",
		'reservationStatus', legacy_retired_sessions."reservationStatus"
	),
	CURRENT_TIMESTAMP + INTERVAL '10 minutes'
FROM legacy_retired_sessions
JOIN "media_asset" AS asset ON asset."id" = legacy_retired_sessions."assetId"
WHERE legacy_retired_sessions."multipartUploadId" IS NULL
UNION ALL
SELECT
	CONCAT('legacy-upload-delete-cleanup:', legacy_retired_sessions."id"),
	'MEDIA_UPLOAD_CLEANUP',
	'MEDIA_ASSET',
	legacy_retired_sessions."assetId",
	CONCAT('media-upload-legacy-delete-cleanup:', legacy_retired_sessions."id"),
	jsonb_build_object(
		'assetId', legacy_retired_sessions."assetId",
		'objectKey', asset."objectKey"
	),
	CURRENT_TIMESTAMP + INTERVAL '10 minutes'
FROM legacy_retired_sessions
JOIN "media_asset" AS asset ON asset."id" = legacy_retired_sessions."assetId"
WHERE legacy_retired_sessions."multipartUploadId" IS NOT NULL
UNION ALL
SELECT
	CONCAT('legacy-upload-abort-cleanup:', legacy_retired_sessions."id"),
	'MEDIA_UPLOAD_CLEANUP',
	'MEDIA_ASSET',
	legacy_retired_sessions."assetId",
	CONCAT('media-upload-legacy-abort-cleanup:', legacy_retired_sessions."id"),
	jsonb_build_object(
		'assetId', legacy_retired_sessions."assetId",
		'objectKey', asset."objectKey",
		'multipartUploadId', legacy_retired_sessions."multipartUploadId",
		'uploadSessionId', legacy_retired_sessions."id",
		'reservationStatus', legacy_retired_sessions."reservationStatus"
	),
	CURRENT_TIMESTAMP + INTERVAL '10 minutes'
FROM legacy_retired_sessions
JOIN "media_asset" AS asset ON asset."id" = legacy_retired_sessions."assetId"
WHERE legacy_retired_sessions."multipartUploadId" IS NOT NULL

UNION ALL
SELECT
	CONCAT('legacy-upload-reverify:', quarantined_completed_assets."id"),
	'MEDIA_ASSET_LEGACY_REVERIFY',
	'MEDIA_ASSET',
	quarantined_completed_assets."id",
	CONCAT('media-upload-legacy-reverify:', quarantined_completed_assets."id"),
	jsonb_build_object(
		'assetId', quarantined_completed_assets."id",
		'allowQuarantinedReverification', true
	),
	GREATEST(
		CURRENT_TIMESTAMP + INTERVAL '10 minutes',
		completed_session."expiresAt" + INTERVAL '10 minutes'
	)
FROM quarantined_completed_assets
JOIN LATERAL (
	SELECT MAX(session."expiresAt") AS "expiresAt"
	FROM "media_upload_session" AS session
	WHERE session."assetId" = quarantined_completed_assets."id"
) AS completed_session ON TRUE
ON CONFLICT ("dedupeKey") DO NOTHING;
