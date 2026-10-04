import type { PrismaClient } from "../../packages/database/prisma/generated/client";

/** Read-only audit of SeeAPI's server-bound inbox, independent of the legacy Outbox. */
export async function countSeeapiVideoHandoffViolations(
	client: Pick<PrismaClient, "$queryRaw">,
	options: { eventIds?: string[] } = {},
): Promise<bigint> {
	const eventIds = options.eventIds ?? null;
	if (eventIds?.length === 0) return 0n;
	const rows = await client.$queryRaw<Array<{ count: bigint }>>`
		SELECT count(*)::bigint AS count
		FROM "provider_webhook_event" webhook
		LEFT JOIN "generation_job" job ON job."id" = webhook."envelope"->>'jobId'
		LEFT JOIN "video_execution" execution ON execution."jobId" = job."id"
		LEFT JOIN "media_asset" asset ON asset."id" = webhook."envelope"->>'assetId'
		LEFT JOIN "generation_job_asset" binding ON binding."jobId" = job."id"
			AND binding."assetId" = asset."id" AND binding."role" = 'OUTPUT'
		WHERE webhook."provider" = 'seeapi-video-v1'
		  AND (${eventIds}::text[] IS NULL OR webhook."id" = ANY(${eventIds}::text[]))
		  AND (
			jsonb_typeof(webhook."envelope") IS DISTINCT FROM 'object'
			OR webhook."envelope"->>'executionEngine' IS DISTINCT FROM 'video-workflow-v1'
			OR jsonb_typeof(webhook."envelope"->'jobId') IS DISTINCT FROM 'string'
			OR jsonb_typeof(webhook."envelope"->'workflowInstanceId') IS DISTINCT FROM 'string'
			OR jsonb_typeof(webhook."envelope"->'assetId') IS DISTINCT FROM 'string'
			OR coalesce(webhook."envelope"->>'assetId', '') !~ '^[A-Za-z0-9_-]{1,160}$'
			OR webhook."envelope"->>'workflowInstanceId' IS DISTINCT FROM 'video-v1-' || job."id"
			OR job."executionEngine" IS DISTINCT FROM 'video-workflow-v1'
			OR execution."workflowInstanceId" IS DISTINCT FROM webhook."envelope"->>'workflowInstanceId'
			OR execution."workflowSchemaVersion" IS DISTINCT FROM 1
			OR asset."verificationEngine" IS DISTINCT FROM 'video-workflow-v1'
			OR asset."kind" IS DISTINCT FROM 'OUTPUT'
			OR asset."ownerId" IS DISTINCT FROM job."ownerId"
			OR asset."ownerType" IS DISTINCT FROM job."ownerType"
			OR asset."finalizedAt" IS NULL
			OR binding."id" IS NULL
			OR (SELECT count(*) FROM "generation_job_asset" output_binding
				WHERE output_binding."jobId" = job."id" AND output_binding."role" = 'OUTPUT') <> 1
			OR jsonb_typeof(webhook."envelope"->'generation') IS DISTINCT FROM 'number'
			OR (CASE WHEN coalesce(webhook."envelope"->>'generation', '') ~ '^[1-9][0-9]{0,15}$'
				THEN (webhook."envelope"->>'generation')::numeric <= 9007199254740991
				ELSE false END) IS DISTINCT FROM true
			OR jsonb_typeof(webhook."envelope"->'attemptNumber') IS DISTINCT FROM 'number'
			OR (CASE WHEN coalesce(webhook."envelope"->>'attemptNumber', '') ~ '^[1-9][0-9]{0,15}$'
				THEN (webhook."envelope"->>'attemptNumber')::numeric <= 9007199254740991
				ELSE false END) IS DISTINCT FROM true
			OR webhook."providerEventId" IS DISTINCT FROM concat('video-v1:',
				webhook."envelope"->>'assetId', ':', webhook."envelope"->>'generation', ':',
				webhook."envelope"->>'attemptNumber')
			OR jsonb_typeof(webhook."envelope"->'checksum') IS DISTINCT FROM 'string'
			OR coalesce(webhook."envelope"->>'checksum', '') !~ '^[a-f0-9]{64}$'
			OR webhook."envelope"->>'checksum' IS DISTINCT FROM asset."checksum"
			OR binding."assetChecksum" IS DISTINCT FROM webhook."envelope"->>'checksum'
			OR jsonb_typeof(webhook."envelope"->'etag') IS DISTINCT FROM 'string'
			OR coalesce(webhook."envelope"->>'etag', '') = ''
			OR webhook."envelope"->>'etag' IS DISTINCT FROM asset."storageEtag"
			OR execution."stageData"->'outputSpec'->>'assetId' IS DISTINCT FROM asset."id"
			OR execution."stageData"->'outputSpec'->>'checksum' IS DISTINCT FROM webhook."envelope"->>'checksum'
			OR execution."stageData"->'outputSpec'->>'etag' IS DISTINCT FROM webhook."envelope"->>'etag'
			OR job."inputSnapshot"->'visualSafetyProfile'->>'provider' IS DISTINCT FROM 'seeapi'
			OR jsonb_typeof(webhook."envelope"->'visualSafetyContractVersion') IS DISTINCT FROM 'string'
			OR webhook."envelope"->>'visualSafetyContractVersion' IS DISTINCT FROM
				job."inputSnapshot"->'visualSafetyProfile'->>'contractVersion'
			OR jsonb_typeof(webhook."envelope"->'rawBody') IS DISTINCT FROM 'string'
			OR octet_length(convert_to(webhook."envelope"->>'rawBody', 'UTF8')) > 262144
			OR jsonb_typeof(webhook."envelope"->'eventHash') IS DISTINCT FROM 'string'
			OR coalesce(webhook."envelope"->>'eventHash', '') !~ '^[a-f0-9]{64}$'
			OR webhook."envelope"->>'eventHash' IS DISTINCT FROM
				encode(sha256(convert_to(webhook."envelope"->>'rawBody', 'UTF8')), 'hex')
			OR NOT (webhook."envelope" ? 'notifiedAt')
			OR (CASE jsonb_typeof(webhook."envelope"->'notifiedAt')
				WHEN 'null' THEN true
				WHEN 'string' THEN coalesce(webhook."envelope"->>'notifiedAt', '') ~
					'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
					AND pg_input_is_valid(webhook."envelope"->>'notifiedAt', 'timestamp with time zone')
				ELSE false END) IS DISTINCT FROM true
		  )`;
	// Neither providerTaskId nor a taskId inside the callback body is identity authority.
	// Current generation/attempt, stage, provider task and deletion state may advance later.
	return rows[0]?.count ?? 0n;
}
