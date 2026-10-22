import type { Prisma } from "../../generated/client";

export interface StreamingImageFinalizationProjection {
	jobId: string;
	ownerType: string;
	ownerId: string;
	productKey: string;
	serviceClass: string;
	guestTrialId: string | null;
	fundingSource: string;
	attemptId: string | null;
	outputs: Array<{ kind: "remote-url"; url: string }> | null;
}

/** Read only bounded remote URLs; never return a raw/inline transfer envelope. */
export async function readStreamingImageFinalization(
	jobId: string,
	tx: Prisma.TransactionClient,
): Promise<StreamingImageFinalizationProjection | null> {
	const [projection] = await tx.$queryRaw<StreamingImageFinalizationProjection[]>`
		WITH current_job AS (
			SELECT "id", "ownerType", "ownerId", "productKey", "serviceClass", "guestTrialId", "fundingSource"
			FROM "generation_job"
			WHERE "id" = ${jobId} AND "executionEngine" = 'legacy' AND "status" = 'FINALIZING'
		), latest_success AS (
			SELECT "id", "provider", "uncertainSubmission" FROM "generation_attempt"
			WHERE "jobId" = ${jobId} AND "status" = 'SUCCEEDED'
			ORDER BY "attemptNumber" DESC LIMIT 1
		), bounded_outputs AS (
			SELECT attempt."id", attempt."provider", attempt."uncertainSubmission",
				envelope."payload"->'version' AS version,
				CASE WHEN jsonb_typeof(envelope."payload"->'outputs') = 'array'
					THEN envelope."payload"->'outputs' ELSE '[]'::jsonb END AS outputs
			FROM latest_success attempt
			LEFT JOIN "generation_attempt_transfer_envelope" envelope ON envelope."attemptId" = attempt."id"
		)
		SELECT job."id" AS "jobId", job."ownerType", job."ownerId", job."productKey",
			job."serviceClass", job."guestTrialId", job."fundingSource", attempt."id" AS "attemptId",
			CASE WHEN attempt."provider" = 'kie' AND attempt."uncertainSubmission" = false
				AND attempt.version = '1'::jsonb AND jsonb_array_length(attempt.outputs) BETWEEN 1 AND 4
				AND NOT EXISTS (
					SELECT 1 FROM jsonb_array_elements(attempt.outputs) AS item
					WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
						OR item->>'kind' IS DISTINCT FROM 'remote-url'
						OR jsonb_typeof(item->'url') IS DISTINCT FROM 'string'
						OR length(item->>'url') NOT BETWEEN 1 AND 4096
				)
			THEN (
				SELECT jsonb_agg(jsonb_build_object('kind', 'remote-url', 'url', item->>'url') ORDER BY position)
				FROM jsonb_array_elements(attempt.outputs) WITH ORDINALITY AS entries(item, position)
			) ELSE NULL END AS outputs
		FROM current_job job LEFT JOIN bounded_outputs attempt ON true
	`;
	return projection ?? null;
}
