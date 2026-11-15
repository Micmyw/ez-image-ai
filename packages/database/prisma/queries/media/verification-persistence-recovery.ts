import type { ImagePhaseOwner } from "../../../shared/image-phase-ownership";
import type { MediaTransactionClient } from "./types";

/** Observe an exact, relinquished execution. No claim, lease release or ACK happens here. */
export async function readImageVerificationQueryRecovery(
	input: { eventId: string; workflowId: string },
	client: MediaTransactionClient,
) {
	const workerId = `workflow:${input.workflowId}:event:${input.eventId}`;
	const [row] = await client.$queryRaw<
		Array<{
			assetId: string;
			leaseToken: string;
			requiresGeneratedImageProcessing: boolean;
		}>
	>`
	 SELECT asset."id" AS "assetId", event."leaseToken",
	  COALESCE(event."payload"->>'requiresGeneratedImageProcessing' = 'true', FALSE) AS "requiresGeneratedImageProcessing"
	 FROM "outbox_event" event JOIN "media_asset" asset ON asset."id" = event."aggregateId"
	 JOIN "media_workflow_phase_owner" owner ON owner."phaseKind" = 'verification'
	  AND owner."subjectId" = asset."id" AND owner."generation" = asset."verificationGeneration"
	  AND owner."workflowId" = ${input.workflowId} AND owner."leasedUntil" > clock_timestamp()
	 WHERE event."id" = ${input.eventId} AND event."aggregateType" = 'MEDIA_ASSET'
	  AND event."eventType" IN ('MEDIA_ASSET_VERIFY', 'MEDIA_ASSET_MODERATION_REQUESTED')
	  AND (event."payload"->>'assetId' IS NULL OR event."payload"->>'assetId' = asset."id")
	  AND COALESCE(event."payload"->>'allowQuarantinedReverification', 'false') = 'false'
	  AND event."status" = 'LEASED' AND event."lastError" = 'RECOVERY_REQUIRED'
	  AND event."leaseOwner" = ${workerId} AND event."leaseToken" IS NOT NULL
	  AND event."leasedUntil" > clock_timestamp() AND event."availableAt" <= clock_timestamp()
	  AND asset."verificationEngine" = 'legacy' AND asset."status" = 'VERIFYING'
	  AND asset."mimeType" LIKE 'image/%' AND asset."verificationProvider" = 'seeapi'
	  AND asset."deletedAt" IS NULL AND (asset."deleteAfter" IS NULL OR asset."deleteAfter" > clock_timestamp())
	  AND asset."verificationDeadlineAt" > clock_timestamp()
	  AND asset."verificationProviderTaskId" IS NOT NULL AND asset."verificationSubmissionUncertain" = FALSE
	  AND asset."verificationLeaseToken" IS NULL AND asset."verificationLeasedUntil" IS NULL`;
	return row ? { ...row, workerId, eventId: input.eventId } : undefined;
}

/** A completed invocation may surrender only its own claim, never an uncertain submission. */
export async function recoverImageVerificationPersistence(
	input: {
		assetId: string;
		generation: number;
		leaseToken: string;
		providerTaskId: string;
		ruleVersion: string;
		policyVersion: string;
		objectKey: string;
		checksum: string | null;
		phaseOwner?: ImagePhaseOwner;
	},
	client: MediaTransactionClient,
): Promise<boolean> {
	const prefix = `image-verification-persistence:${input.assetId}:g${input.generation}:`;
	return client.$transaction(
		async (tx) => {
			// Read again after waiting for the lock. This never acknowledges the original
			// Outbox receipt or writes moderation evidence; a GET must still prove the verdict.
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${input.assetId}`}, 0))`;
			const rows = await tx.$queryRaw<Array<{ id: string }>>`
		 WITH slot AS (
		  SELECT ${prefix} || n::text AS key FROM generate_series(1, 3) n
		  WHERE NOT EXISTS (SELECT 1 FROM "outbox_event" e WHERE e."dedupeKey" = ${prefix} || n::text)
		  ORDER BY n LIMIT 1
		 ), released AS (
		  UPDATE "media_asset" asset SET "verificationLeaseToken" = NULL,
		   "verificationLeasedUntil" = NULL, "verificationNextAttemptAt" = clock_timestamp(),
		   "updatedAt" = clock_timestamp()
		  WHERE asset."id" = ${input.assetId} AND asset."verificationEngine" = 'legacy'
		   AND asset."status" = 'VERIFYING' AND asset."deletedAt" IS NULL
		   AND asset."mimeType" LIKE 'image/%' AND asset."verificationProvider" = 'seeapi'
		   AND asset."verificationGeneration" = ${input.generation}
		   AND asset."verificationLeaseToken" = ${input.leaseToken}
		   AND asset."verificationLeasedUntil" > clock_timestamp()
		   AND asset."verificationDeadlineAt" > clock_timestamp()
		   AND (asset."deleteAfter" IS NULL OR asset."deleteAfter" > clock_timestamp())
		   AND asset."verificationProviderTaskId" = ${input.providerTaskId}
		   AND asset."verificationSubmissionUncertain" = FALSE
		   AND asset."verificationRuleVersion" = ${input.ruleVersion}
		   AND asset."verificationPolicyVersion" = ${input.policyVersion}
		   AND asset."objectKey" = ${input.objectKey}
		   AND asset."checksum" IS NOT DISTINCT FROM ${input.checksum}::text
		   AND EXISTS (SELECT 1 FROM slot)
		   AND EXISTS (SELECT 1 FROM (SELECT 1) anchor
		    LEFT JOIN "media_workflow_phase_owner" owner ON owner."phaseKind" = 'verification'
		     AND owner."subjectId" = asset."id" AND owner."generation" = asset."verificationGeneration"
		     AND owner."leasedUntil" > clock_timestamp()
		    WHERE (${input.phaseOwner?.phaseKey ?? null}::text IS NULL AND owner."phaseKey" IS NULL)
		     OR (owner."phaseKey" = ${input.phaseOwner?.phaseKey ?? null}
		      AND owner."workflowId" = ${input.phaseOwner?.workflowId ?? null}
		      AND owner."epoch" = ${input.phaseOwner?.epoch ?? null}::int))
		  RETURNING asset."id"
		 )
		 INSERT INTO "outbox_event" ("id", "eventType", "aggregateType", "aggregateId", "dedupeKey", "payload")
		 SELECT ${crypto.randomUUID()}, 'MEDIA_ASSET_VERIFY', 'MEDIA_ASSET', released."id", slot.key,
		  jsonb_build_object('assetId', released."id", 'queryOnly', true)
		 FROM released CROSS JOIN slot RETURNING "id"`;
			return rows.length === 1;
		},
		{ maxWait: 5_000, timeout: 10_000 },
	);
}
