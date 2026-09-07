import { type ImageSkuKey } from "@repo/config";

import { Prisma } from "../../generated/client";
import type { GenerationJobStatus } from "../../generated/client";
import {
	type AdminSafeImageProductDefinition,
	type AdminSafeImageProductKey,
	validateAdminSafeImageProductDefinitions,
} from "./admin-safe-image-catalog";
import type { MediaTransactionClient } from "./types";

export type EzPicOperationsProductKey = AdminSafeImageProductKey;
export type EzPicOperationsSkuKey = ImageSkuKey;

export interface AdminGrowthOperationsInput {
	productKey?: EzPicOperationsProductKey;
	skuKey?: EzPicOperationsSkuKey;
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
	reserved: bigint;
	charged: bigint;
	released: bigint;
}

function filteredJobs(
	input: AdminGrowthOperationsInput,
	products: readonly AdminSafeImageProductDefinition[],
): Prisma.Sql {
	const productKeys = products.map(({ productKey }) => productKey);
	const skuCases = products.map(
		({ productKey, skuCells }) => Prisma.sql`
			WHEN job."productKey" = ${productKey}
			  AND job."inputSnapshot"->>'skuKey' IN (${Prisma.join(skuCells.map(({ skuKey }) => skuKey))})
			  THEN job."inputSnapshot"->>'skuKey'`,
	);
	const conditions: Prisma.Sql[] = [
		Prisma.sql`job."productKey" IN (${Prisma.join(productKeys)})`,
		Prisma.sql`job."createdAt" >= ${input.from}`,
		Prisma.sql`job."createdAt" < ${input.to}`,
	];
	if (input.productKey) conditions.push(Prisma.sql`job."productKey" = ${input.productKey}`);
	if (input.skuKey) {
		const skuProduct = products.find(({ skuCells }) =>
			skuCells.some(({ skuKey }) => skuKey === input.skuKey),
		);
		if (!skuProduct || (input.productKey && input.productKey !== skuProduct.productKey)) {
			throw new Error("skuKey is not valid for productKey");
		}
		conditions.push(Prisma.sql`job."productKey" = ${skuProduct.productKey}`);
		conditions.push(Prisma.sql`job."inputSnapshot"->>'skuKey' = ${input.skuKey}`);
	}
	if (input.status) conditions.push(Prisma.sql`job."status"::text = ${input.status}`);

	return Prisma.sql`
		SELECT job."id",
		       job."productKey",
		       CASE
		         ${Prisma.join(skuCases, " ")}
		         ELSE NULL
		       END AS "skuKey",
		       job."status"::text AS "status",
		       job."failureCode",
		       job."editSessionId",
		       attempt."submittedAt",
		       attempt."completedAt",
		       COALESCE(reservation."amount", 0)::bigint AS "reserved",
		       COALESCE(reservation."settledAmount", 0)::bigint AS "charged",
		       COALESCE(reservation."releasedAmount", 0)::bigint AS "released"
		FROM "generation_job" job
		LEFT JOIN LATERAL (
			SELECT candidate."submittedAt", candidate."completedAt"
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
	productDefinitions: readonly AdminSafeImageProductDefinition[],
) {
	const products = validateAdminSafeImageProductDefinitions(productDefinitions);
	const filtered = filteredJobs(input, products);
	const [summaryRows, moderationRows, repeatRows, failureRows, skuRows, overrides] =
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
					skuKey: ImageSkuKey | null;
					status: GenerationJobStatus;
					jobs: bigint;
				}>
			>(Prisma.sql`
				WITH filtered_job AS (${filtered})
				SELECT "productKey", "skuKey",
				       "status",
				       COUNT(*)::bigint AS "jobs"
				FROM filtered_job
				GROUP BY "productKey", "skuKey", "status"
				ORDER BY "productKey", "skuKey", "status"`),
			client.runtimeConfigOverride.findMany({
				where: {
					active: true,
					configKey: {
						in: [
							"media.generation.enabled",
							...products.map(({ productKey }) => `media.model.${productKey}.enabled`),
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
	const productControl = (productKey: EzPicOperationsProductKey, publicName: string) => ({
		productKey,
		publicName,
		enabled: generationEnabled && activeValues.get(`media.model.${productKey}.enabled`) !== false,
	});

	return {
		summary: {
			jobs: Number(summary.jobs),
			succeeded: Number(summary.succeeded),
			failed: Number(summary.failed),
			successRate: summary.successRate,
			latencyMs: {
				p50: summary.p50LatencyMs === null ? null : Number(summary.p50LatencyMs),
				p95: summary.p95LatencyMs === null ? null : Number(summary.p95LatencyMs),
			},
			moderationRejectionRate: ratio(moderation.rejected, moderation.total),
			repeatEditRate: ratio(repeat.repeated, repeat.sessions),
		},
		credits: {
			reserved: summary.reserved.toString(),
			charged: summary.charged.toString(),
			released: summary.released.toString(),
		},
		failureCodes: failureRows.map((row) => ({ code: row.code, count: Number(row.count) })),
		skuBreakdown: skuRows.map((row) => ({ ...row, jobs: Number(row.jobs) })),
		controls: {
			generationEnabled,
			products: products.map(({ productKey, publicName }) =>
				productControl(productKey, publicName),
			),
		},
	};
}
