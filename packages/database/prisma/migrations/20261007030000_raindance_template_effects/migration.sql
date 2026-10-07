BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '45s';

-- Widen only the template effect allowlist. Existing Hotel Lobby rows, immutable
-- identities, private boundaries and every other shape/state guard are retained.
ALTER TABLE "video_template_execution"
 DROP CONSTRAINT "video_template_shape_check",
 ADD CONSTRAINT "video_template_shape_check" CHECK (
 jsonb_typeof("templateSnapshot") IS NOT DISTINCT FROM 'object'
 AND ("templateSnapshot"->>'effectId' IN ('hotel-lobby-duo','raindance-solo','raindance-duo')) IS TRUE
 AND jsonb_typeof("orderedRoleIdentities") IS NOT DISTINCT FROM 'array'
 AND jsonb_array_length("orderedRoleIdentities")=2
 AND "orderedRoleIdentities"->0->>'role' IS NOT DISTINCT FROM 'left'
 AND "orderedRoleIdentities"->1->>'role' IS NOT DISTINCT FROM 'right'
 AND "sceneState" IN ('PENDING','SUBMITTING','SUBMISSION_UNCERTAIN','GENERATING','STORING','READY','FAILED','NEEDS_REVIEW')
 AND ("sceneProviderTaskId" IS NULL OR "submittedAt" IS NOT NULL)
 AND ("resolvedInputIdentity" IS NULL OR ("sceneAssetId" IS NOT NULL AND "resolvedAt" IS NOT NULL))
);

COMMIT;
