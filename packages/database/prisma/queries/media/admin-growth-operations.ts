import { Prisma } from "../../generated/client";
import type { GenerationJobStatus } from "../../generated/client";
import type { MediaTransactionClient } from "./types";

export type EzPicOperationsProductKey = "image-fast" | "image-quality";

export interface AdminGrowthOperationsInput {
	productKey?: EzPicOperationsProductKey;
	provider?: string;
	model?: string;
	status?: GenerationJobStatus;
	from: Date;
	to: Date;
	generationEnabled: boolean;
}

interface SummaryRow {
	jobs: bigint;
	succeeded: bigint;
	failed: bigint;
	successRate: number | null;
	p50LatencyMs: bigint | null;
	p95LatencyMs: bigint | null;
	averageProviderCostMicros: bigint | null;
	reserved: bigint;
	charged: bigint;
	released: bigint;
}

function filteredJobs(input: AdminGrowthOperationsInput): Prisma.Sql {
	const conditions: Prisma.Sql[] = [
		Prisma.sql`job."productKey" IN ('image-fast', 'image-quality')`,
		Prisma.sql`job."createdAt" >= ${input.from}`,
		Prisma.sql`job."createdAt" < ${input.to}`,
	];
	if (input.productKey) conditions.push(Prisma.sql`job."productKey" = ${input.productKey}`);
	if (input.status) conditions.push(Prisma.sql`job."status"::text = ${input.status}`);
	if (input.provider) conditions.push(Prisma.sql`attempt."provider" = ${input.provider}`);
	if (input.model) conditions.push(Prisma.sql`attempt."providerModelId" = ${input.model}`);

	return Prisma.sql`
		SELECT job."id",
		       job."productKey",
		       job."status"::text AS "status",
		       job."failureCode",
		       job."editSessionId",
		       attempt."provider",
		       attempt."providerModelId" AS "model",
		       attempt."providerCostMicros",
		       attempt."submittedAt",
		       attempt."completedAt",
		       COALESCE(reservation."amount", 0)::bigint AS "reserved",
		       COALESCE(reservation."settledAmount", 0)::bigint AS "charged",
		       COALESCE(reservation."releasedAmount", 0)::bigint AS "released"
		FROM "generation_job" job
		LEFT JOIN LATERAL (
			SELECT candidate."provider", candidate."providerModelId",
			       candidate."providerCostMicros", candidate."submittedAt", candidate."completedAt"
			FROM "generation_attempt" candidate
			WHERE candidate."jobId" = job."id"
			ORDER BY candidate."attemptNumber" DESC, candidate."id" DESC
			LIMIT 1
		) attempt ON true
		LEFT JOIN "credit_reservation" reservation ON reservation."jobId" = job."id"
		WHERE ${Prisma.join(conditions, " AND ")}`;
}

function ratio(numerator: bigint, denominator: bigint): number | null {
	if (denominator === 0n) return null;
	return Math.round((Number(numerator) / Number(denominator)) * 10_000) / 10_000;
}

export async function getAdminGrowthOperations(
	input: AdminGrowthOperationsInput,
	client: MediaTransactionClient,
) {
	const filtered = filteredJobs(input);
	const [summaryRows, moderationRows, repeatRows, failureRows, routeRows, overrides] =
		await Promise.all([
			client.$queryRaw<SummaryRow[]>(Prisma.sql`
				WITH filtered_job AS (${filtered})
				SELECT COUNT(*)::bigint AS "jobs",
				       COUNT(*) FILTER (WHERE "status" = 'SUCCEEDED')::bigint AS "succeeded",
				       COUNT(*) FILTER (WHERE "status" = 'FAILED')::bigint AS "failed",
				       CASE WHEN COUNT(*) FILTER (WHERE "status" IN ('SUCCEEDED', 'FAILED')) = 0
				         THEN NULL
				         ELSE ROUND(
				           COUNT(*) FILTER (WHERE "status" = 'SUCCEEDED')::numeric /
				           COUNT(*) FILTER (WHERE "status" IN ('SUCCEEDED', 'FAILED')),
				           4
				         )::double precision
				       END AS "successRate",
				       ROUND((percentile_cont(0.5) WITHIN GROUP (
				         ORDER BY EXTRACT(EPOCH FROM ("completedAt" - "submittedAt")) * 1000
				       ) FILTER (WHERE "status" = 'SUCCEEDED' AND "completedAt" IS NOT NULL AND "submittedAt" IS NOT NULL))::numeric)::bigint AS "p50LatencyMs",
				       ROUND((percentile_cont(0.95) WITHIN GROUP (
				         ORDER BY EXTRACT(EPOCH FROM ("completedAt" - "submittedAt")) * 1000
				       ) FILTER (WHERE "status" = 'SUCCEEDED' AND "completedAt" IS NOT NULL AND "submittedAt" IS NOT NULL))::numeric)::bigint AS "p95LatencyMs",
				       ROUND(AVG("providerCostMicros"))::bigint AS "averageProviderCostMicros",
				       COALESCE(SUM("reserved"), 0)::bigint AS "reserved",
				       COALESCE(SUM("charged"), 0)::bigint AS "charged",
				       COALESCE(SUM("released"), 0)::bigint AS "released"
				FROM filtered_job`),
			client.$queryRaw<Array<{ total: bigint; rejected: bigint }>>(Prisma.sql`
				WITH filtered_job AS (${filtered})
				SELECT COUNT(moderation.*)::bigint AS "total",
				       COUNT(moderation.*) FILTER (WHERE moderation."status" = 'REJECTED')::bigint AS "rejected"
				FROM filtered_job job
				JOIN "generation_job_asset" binding
				  ON binding."jobId" = job."id" AND binding."role" = 'INPUT'
				LEFT JOIN LATERAL (
					SELECT result."status"
					FROM "asset_moderation_result" result
					WHERE result."assetId" = binding."assetId"
					ORDER BY result."verificationGeneration" DESC,
					         result."attemptNumber" DESC, result."createdAt" DESC, result."id" DESC
					LIMIT 1
				) moderation ON true`),
			client.$queryRaw<Array<{ sessions: bigint; repeated: bigint }>>(Prisma.sql`
				WITH filtered_job AS (${filtered}), session_count AS (
					SELECT "editSessionId", COUNT(*)::bigint AS jobs
					FROM filtered_job
					WHERE "editSessionId" IS NOT NULL
					GROUP BY "editSessionId"
				)
				SELECT COUNT(*)::bigint AS "sessions",
				       COUNT(*) FILTER (WHERE jobs > 1)::bigint AS "repeated"
				FROM session_count`),
			client.$queryRaw<Array<{ code: string; count: bigint }>>(Prisma.sql`
				WITH filtered_job AS (${filtered})
				SELECT CASE
				         WHEN "failureCode" ~ '^[A-Z][A-Z0-9_]{0,127}$' THEN "failureCode"
				         ELSE 'UNCLASSIFIED_FAILURE'
				       END AS "code",
				       COUNT(*)::bigint AS "count"
				FROM filtered_job
				WHERE "failureCode" IS NOT NULL
				GROUP BY "code"
				ORDER BY COUNT(*) DESC, "code" ASC`),
			client.$queryRaw<
				Array<{
					productKey: EzPicOperationsProductKey;
					provider: string;
					model: string;
					status: GenerationJobStatus;
					jobs: bigint;
				}>
			>(Prisma.sql`
				WITH filtered_job AS (${filtered})
				SELECT "productKey",
				       COALESCE("provider", 'unassigned') AS "provider",
				       COALESCE("model", 'unassigned') AS "model",
				       "status",
				       COUNT(*)::bigint AS "jobs"
				FROM filtered_job
				GROUP BY "productKey", "provider", "model", "status"
				ORDER BY "productKey", "provider", "model", "status"`),
			client.runtimeConfigOverride.findMany({
				where: {
					active: true,
					configKey: {
						in: [
							"media.generation.enabled",
							"media.model.image-fast.enabled",
							"media.model.image-quality.enabled",
						],
					},
				},
				select: { configKey: true, value: true, version: true },
				orderBy: { version: "desc" },
			}),
		]);

	const summary = summaryRows[0] ?? {
		jobs: 0n,
		succeeded: 0n,
		failed: 0n,
		successRate: null,
		p50LatencyMs: null,
		p95LatencyMs: null,
		averageProviderCostMicros: null,
		reserved: 0n,
		charged: 0n,
		released: 0n,
	};
	const moderation = moderationRows[0] ?? { total: 0n, rejected: 0n };
	const repeat = repeatRows[0] ?? { sessions: 0n, repeated: 0n };
	const activeValues = new Map<string, unknown>();
	for (const override of overrides) {
		if (!activeValues.has(override.configKey)) activeValues.set(override.configKey, override.value);
	}
	const generationEnabled =
		input.generationEnabled && activeValues.get("media.generation.enabled") !== false;
	const productControl = (
		productKey: EzPicOperationsProductKey,
		publicName: "Standard Edit" | "Quality Edit",
	) => ({
		productKey,
		publicName,
		enabled: generationEnabled && activeValues.get(`media.model.${productKey}.enabled`) !== false,
	});

	return {
		generatedAt: new Date().toISOString(),
		summary: {
			jobs: Number(summary.jobs),
			succeeded: Number(summary.succeeded),
			failed: Number(summary.failed),
			successRate: summary.successRate,
			latencyMs: {
				p50: summary.p50LatencyMs === null ? null : Number(summary.p50LatencyMs),
				p95: summary.p95LatencyMs === null ? null : Number(summary.p95LatencyMs),
			},
			averageProviderCostMicros: summary.averageProviderCostMicros?.toString() ?? null,
			moderationRejectionRate: ratio(moderation.rejected, moderation.total),
			repeatEditRate: ratio(repeat.repeated, repeat.sessions),
		},
		credits: {
			reserved: summary.reserved.toString(),
			charged: summary.charged.toString(),
			released: summary.released.toString(),
		},
		failureCodes: failureRows.map((row) => ({ code: row.code, count: Number(row.count) })),
		routes: routeRows.map((row) => ({ ...row, jobs: Number(row.jobs) })),
		controls: {
			generationEnabled,
			products: [
				productControl("image-fast", "Standard Edit"),
				productControl("image-quality", "Quality Edit"),
			],
		},
	};
}
