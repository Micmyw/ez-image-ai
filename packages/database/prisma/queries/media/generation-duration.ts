import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";

import { Prisma } from "#prisma-runtime-client";

import {
	GENERATION_DURATION_FRESHNESS_MS,
	GENERATION_DURATION_MAXIMUM_SAMPLES,
	GENERATION_DURATION_MINIMUM_SAMPLES,
	generationDurationInputSchema,
	type GenerationDurationInput,
	type GenerationDurationEstimate,
} from "../../../shared/generation-duration";
import type { MediaDatabaseClient } from "./types";

interface DurationAggregate {
	sampleSize: number;
	p50Seconds: number | null;
	p90Seconds: number | null;
	asOf: Date;
	latestSampleAt: Date | null;
}

/** Read-only, bounded whole-job observations. No per-user or per-job fields leave this query. */
export async function getGenerationDurationEstimate(
	input: GenerationDurationInput,
	client: MediaDatabaseClient,
): Promise<GenerationDurationEstimate> {
	const selection = generationDurationInputSchema.parse(input);
	const [aggregate] = await client.$queryRaw<DurationAggregate[]>(Prisma.sql`
		WITH observation AS (SELECT statement_timestamp() AS "asOf"),
		candidates AS MATERIALIZED (
			SELECT job."id", job."ownerId", job."submittedByUserId", job."createdAt", job."terminalAt",
				job."fundingSource", job."archivedCreditsCharged", job."archivedCreditsReleased"
			FROM "generation_job" job, observation
			WHERE job."status" = 'SUCCEEDED' AND job."executionEngine" = 'legacy'
				AND job."productKey" = ${selection.productKey}
				AND job."catalogVersion" = ${DEFAULT_PRODUCT_CONFIG.catalogVersion}
				AND job."pricingVersion" = ${DEFAULT_PRODUCT_CONFIG.pricingVersion}
				AND job."inputSnapshot"->>'skuKey' = ${selection.skuKey}
				AND job."serviceClass"::text = ${selection.serviceClass}
				AND job."ownerType" = 'USER'
				AND job."updatedAt" >= observation."asOf" - INTERVAL '7 days'
				AND job."updatedAt" <= observation."asOf"
			ORDER BY job."updatedAt" DESC, job."id" DESC LIMIT 500
		), samples AS MATERIALIZED (
			SELECT EXTRACT(EPOCH FROM (job."terminalAt" - job."createdAt"))::double precision AS seconds,
				job."terminalAt"
			FROM candidates job
			JOIN "user" owner ON owner."id" = job."ownerId"
			JOIN "user" submitter ON submitter."id" = job."submittedByUserId"
			CROSS JOIN observation
			WHERE job."terminalAt" > job."createdAt"
				AND job."terminalAt" >= observation."asOf" - INTERVAL '7 days'
				AND job."terminalAt" <= observation."asOf"
				AND COALESCE(owner."role", '') <> 'admin'
				AND COALESCE(submitter."role", '') <> 'admin'
				AND job."fundingSource" IN ('CREDITS', 'IMAGE_PASS')
				AND job."archivedCreditsCharged" IS NULL AND job."archivedCreditsReleased" IS NULL
				AND NOT EXISTS (
					SELECT 1 FROM "growth_event" marked
					WHERE marked."userId" IN (job."ownerId", job."submittedByUserId") AND marked."internal" = true
				)
				AND EXISTS (
					SELECT 1 FROM "generation_attempt" attempt WHERE attempt."jobId" = job."id"
						AND attempt."status" = 'SUCCEEDED'
						AND attempt."provider" IN ('kie', 'fal', 'replicate', 'gemini', 'openrouter')
						AND NULLIF(attempt."providerTaskId", '') IS NOT NULL
						AND attempt."providerTaskId" !~* '^(mock|test|fixture)[_:-]'
				)
			ORDER BY job."terminalAt" DESC, job."id" DESC LIMIT ${GENERATION_DURATION_MAXIMUM_SAMPLES}
		)
		SELECT COUNT(*)::int AS "sampleSize",
			percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS "p50Seconds",
			percentile_cont(0.9) WITHIN GROUP (ORDER BY seconds) AS "p90Seconds",
			MAX("terminalAt") AS "latestSampleAt", (SELECT "asOf" FROM observation) AS "asOf"
		FROM samples
	`);
	if (
		!aggregate ||
		aggregate.sampleSize < GENERATION_DURATION_MINIMUM_SAMPLES ||
		!aggregate.latestSampleAt ||
		aggregate.asOf.getTime() - aggregate.latestSampleAt.getTime() >
			GENERATION_DURATION_FRESHNESS_MS ||
		aggregate.latestSampleAt > aggregate.asOf ||
		!Number.isFinite(aggregate.p50Seconds) ||
		!Number.isFinite(aggregate.p90Seconds) ||
		aggregate.p50Seconds === null ||
		aggregate.p90Seconds === null ||
		aggregate.p50Seconds <= 0 ||
		aggregate.p90Seconds < aggregate.p50Seconds
	) {
		return { kind: "processing" };
	}
	return {
		kind: "range",
		minimumSeconds: Math.max(1, Math.round(aggregate.p50Seconds)),
		maximumSeconds: Math.max(1, Math.ceil(aggregate.p90Seconds)),
		sampleSize: aggregate.sampleSize,
		asOf: aggregate.asOf.toISOString(),
		latestSampleAt: aggregate.latestSampleAt.toISOString(),
		percentiles: "p50-p90",
		windowHours: 168,
		cohort: "completed-tasks-excluding-marked-internal",
	};
}
