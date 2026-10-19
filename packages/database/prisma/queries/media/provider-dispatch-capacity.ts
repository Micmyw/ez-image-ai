import { expandVideoRuntimeEnvironment } from "@repo/config/video-runtime-environment";

import type { Prisma } from "../../generated/client";

export const PROVIDER_DISPATCH_RETRY_MS = 5_000;

/** All Kie generation adapters use the same configured account. Other provider
 * quotas must be configured explicitly before adding a limit for them here. */
export async function lockProviderDispatchCapacity(
	tx: Prisma.TransactionClient,
	provider: string,
): Promise<void> {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media:provider-capacity:${provider}`}, 0))`;
}

/** Called after the provider lock and before any may-have-sent fence. The caller
 * must use ReadCommitted: this separate statement sees the preceding winner.
 * A lease, job stage, or elapsed time is never proof that a provider finished.
 * The narrow legacy-success branch recognizes the old successful result writer
 * that omitted completedAt; it reads frozen output evidence and terminal job
 * identity without changing billing, attempts, or retained assets. */
export async function hasProviderDispatchCapacity(
	tx: Prisma.TransactionClient,
	provider: string,
	environment: Record<string, string | undefined> = process.env,
): Promise<boolean> {
	if (provider !== "kie") return true;
	const maximum = configuredProviderDispatchKieCapacity(environment);
	if (maximum === null) return false;
	const [row] = await tx.$queryRaw<Array<{ active: bigint }>>`
		SELECT (
			(SELECT count(*) FROM "generation_attempt" a
			 WHERE a."provider" = ${provider}
			   AND (a."uncertainSubmission" OR a."submittedAt" IS NOT NULL
			        OR a."providerTaskId" IS NOT NULL
			        OR a."status"::text IN ('SUBMISSION_UNCERTAIN', 'SUBMITTED', 'RUNNING'))
			   AND NOT ((a."status"::text IN ('SUCCEEDED', 'FAILED', 'CANCELED')
			            AND NOT a."uncertainSubmission" AND a."completedAt" IS NOT NULL)
			     OR COALESCE((
			       a."status"::text = 'SUCCEEDED' AND NOT a."uncertainSubmission"
			       AND a."completedAt" IS NULL
			       AND a."providerTaskId" IS NOT NULL AND btrim(a."providerTaskId") <> ''
			       AND a."responseSnapshot"->'providerCharged' = 'true'::jsonb
			       AND a."responseSnapshot"->'outputCount' IN ('1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb)
			       AND EXISTS (SELECT 1 FROM "generation_job" j
			         WHERE j."id" = a."jobId" AND j."executionEngine" = 'legacy'
			           AND j."terminalAt" IS NOT NULL AND j."status"::text IN ('SUCCEEDED', 'FAILED'))
			     ), false)
			     OR COALESCE((
			       jsonb_typeof(a."responseSnapshot"->'providerTerminalEvidence') = 'object'
			       AND a."responseSnapshot"->'providerTerminalEvidence'->'version' = '1'::jsonb
			       AND a."responseSnapshot"->'providerTerminalEvidence'->>'provider' = a."provider"
			       AND a."responseSnapshot"->'providerTerminalEvidence'->>'source' = 'kie-record-info'
			       AND jsonb_typeof(a."responseSnapshot"->'providerTerminalEvidence'->'attemptId') = 'string'
			       AND a."responseSnapshot"->'providerTerminalEvidence'->>'attemptId' = a."id"
			       AND a."providerTaskId" IS NOT NULL AND a."providerTaskId" <> ''
			       AND jsonb_typeof(a."responseSnapshot"->'providerTerminalEvidence'->'providerTaskId') = 'string'
			       AND a."responseSnapshot"->'providerTerminalEvidence'->>'providerTaskId' = a."providerTaskId"
			       AND a."responseSnapshot"->'providerTerminalEvidence'->>'status' IN ('SUCCEEDED', 'FAILED', 'CANCELED')
			       AND jsonb_typeof(a."responseSnapshot"->'providerTerminalEvidence'->'verifiedAt') = 'string'
			       AND a."responseSnapshot"->'providerTerminalEvidence'->>'verifiedAt'
			           ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'
			       AND substring(a."responseSnapshot"->'providerTerminalEvidence'->>'verifiedAt', 1, 4) <> '0000'
			       AND (substring(a."responseSnapshot"->'providerTerminalEvidence'->>'verifiedAt', 6, 2) NOT IN ('04', '06', '09', '11')
			         OR substring(a."responseSnapshot"->'providerTerminalEvidence'->>'verifiedAt', 9, 2) <> '31')
			       AND (substring(a."responseSnapshot"->'providerTerminalEvidence'->>'verifiedAt', 6, 2) <> '02'
			         OR substring(a."responseSnapshot"->'providerTerminalEvidence'->>'verifiedAt', 9, 2) <= '28'
			         OR (substring(a."responseSnapshot"->'providerTerminalEvidence'->>'verifiedAt', 9, 2) = '29'
			           AND substring(a."responseSnapshot"->'providerTerminalEvidence'->>'verifiedAt', 1, 4)
			             ~ '^([0-9]{2}(0[48]|[2468][048]|[13579][26])|([02468][048]|[13579][26])00)$'))
			       AND a."responseSnapshot"->'providerTerminalEvidence'->>'verifiedAt'
			         <= to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
			     ), false)))
			+
			(SELECT count(*) FROM "video_template_execution" s
			 WHERE (s."submittedAt" IS NOT NULL OR s."acceptedAt" IS NOT NULL
			        OR s."sceneSubmissionUncertain" OR s."sceneProviderTaskId" IS NOT NULL
			        OR s."sceneState" IN ('SUBMITTING', 'GENERATING'))
			   AND NOT (COALESCE(s."sceneProviderEvidence"->>'status', '') IN ('SUCCEEDED', 'FAILED')
			        OR (s."sceneState" = 'FAILED' AND NOT s."sceneSubmissionUncertain"
			            AND s."sceneProviderTaskId" IS NULL AND s."acceptedAt" IS NULL)))
		) AS "active"`;
	if (!row) throw new Error("PROVIDER_CAPACITY_COUNT_UNAVAILABLE");
	return row.active < BigInt(maximum);
}

/** Preserve the existing packed/flat server configuration and conflict checks. */
export function configuredProviderDispatchKieCapacity(
	environment: Record<string, string | undefined> = process.env,
): number | null {
	const value = Number(expandVideoRuntimeEnvironment(environment).VIDEO_V1_PROVIDER_CONCURRENCY);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}
