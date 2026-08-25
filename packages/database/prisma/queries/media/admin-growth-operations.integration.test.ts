import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as mediaQueries from ".";
import { PrismaClient } from "../../generated/client";

type GrowthOperationsQuery = (
	input: {
		productKey?: "image-fast" | "image-quality";
		provider?: string;
		model?: string;
		status?:
			| "RESERVED"
			| "DISPATCH_QUEUED"
			| "SUBMITTING"
			| "PROVIDER_PENDING"
			| "PROVIDER_RUNNING"
			| "NEEDS_RECONCILIATION"
			| "FINALIZING"
			| "SUCCEEDED"
			| "FAILED"
			| "CANCELED";
		from: Date;
		to: Date;
		generationEnabled: boolean;
	},
	client: PrismaClient,
) => Promise<{
	generatedAt: string;
	summary: {
		jobs: number;
		succeeded: number;
		failed: number;
		successRate: number | null;
		latencyMs: { p50: number | null; p95: number | null };
		averageProviderCostMicros: string | null;
		moderationRejectionRate: number | null;
		repeatEditRate: number | null;
	};
	credits: { reserved: string; charged: string; released: string };
	failureCodes: Array<{ code: string; count: number }>;
	routes: Array<{
		productKey: "image-fast" | "image-quality";
		provider: string;
		model: string;
		status: string;
		jobs: number;
	}>;
	controls: {
		generationEnabled: boolean;
		products: Array<{
			productKey: "image-fast" | "image-quality";
			publicName: "Standard Edit" | "Quality Edit";
			enabled: boolean;
		}>;
	};
}>;

const getAdminGrowthOperations = (
	mediaQueries as typeof mediaQueries & { getAdminGrowthOperations?: GrowthOperationsQuery }
).getAdminGrowthOperations;

const approvedGrowthTestDatabases = new Set([
	"ezpic_pr7_growth_operations_test",
	"ezpic_pr8_test",
	...(process.env.CI === "true" ? ["ai_media_foundation_test"] : []),
]);

function safeTestDatabaseUrl(): string {
	const value = process.env.TEST_DATABASE_URL;
	if (!value) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	if (process.env.DATABASE_URL === value) throw new Error("UNSAFE_TEST_DATABASE");
	const parsed = new URL(value);
	if (
		parsed.hostname !== "127.0.0.1" ||
		parsed.port !== "55432" ||
		!approvedGrowthTestDatabases.has(parsed.pathname.slice(1))
	) {
		throw new Error("UNSAFE_TEST_DATABASE");
	}
	return value;
}

describe("admin growth operations aggregate query", () => {
	let client: PrismaClient | undefined;
	const suffix = crypto.randomUUID();
	const ownerId = `growth-owner-${suffix}`;
	const accountId = `growth-account-${suffix}`;
	const quoteIds = Array.from({ length: 4 }, (_, index) => `growth-quote-${index}-${suffix}`);
	const jobIds = Array.from({ length: 4 }, (_, index) => `growth-job-${index}-${suffix}`);
	const assetIds = Array.from({ length: 3 }, (_, index) => `growth-asset-${index}-${suffix}`);
	const sessionIds = [`growth-session-a-${suffix}`, `growth-session-b-${suffix}`];
	const from = new Date("2099-01-01T00:00:00.000Z");
	const to = new Date("2099-02-01T00:00:00.000Z");

	beforeAll(async () => {
		if (!getAdminGrowthOperations) return;
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
		await truncateDedicatedGrowthFixtures(client);
		await seedFixtures(client);
	});

	afterAll(async () => {
		if (!client) return;
		try {
			await truncateDedicatedGrowthFixtures(client);
		} finally {
			await client.$disconnect();
		}
	});

	it("aggregates success, latency, cost, moderation, credits, repeat edits, and controls", async () => {
		expect(getAdminGrowthOperations).toBeTypeOf("function");
		if (!getAdminGrowthOperations || !client) return;

		const result = await getAdminGrowthOperations({ from, to, generationEnabled: true }, client);

		expect(result.summary).toEqual({
			jobs: 4,
			succeeded: 2,
			failed: 1,
			successRate: 0.6667,
			latencyMs: { p50: 5_000, p95: 7_700 },
			averageProviderCostMicros: "166667",
			moderationRejectionRate: 0.3333,
			repeatEditRate: 0.5,
		});
		expect(result.credits).toEqual({ reserved: "60", charged: "30", released: "20" });
		expect(result.failureCodes).toEqual([{ code: "PROVIDER_FAILED", count: 1 }]);
		expect(result.controls).toEqual({
			generationEnabled: true,
			products: [
				{ productKey: "image-fast", publicName: "Standard Edit", enabled: true },
				{ productKey: "image-quality", publicName: "Quality Edit", enabled: false },
			],
		});
		expect(result.routes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					productKey: "image-fast",
					provider: "fal",
					model: "model-standard",
					status: "SUCCEEDED",
					jobs: 1,
				}),
				expect.objectContaining({
					productKey: "image-quality",
					provider: "fal",
					model: "model-quality",
					status: "FAILED",
					jobs: 1,
				}),
			]),
		);
		expect(JSON.stringify(result)).not.toMatch(
			/prompt|objectKey|signedUrl|sourceUrl|providerTaskId|requestSnapshot|responseSnapshot|rawEnvelope|ownerId|jobId/i,
		);
	});

	it("applies product, provider, model, status, and date filters to the same aggregate boundary", async () => {
		expect(getAdminGrowthOperations).toBeTypeOf("function");
		if (!getAdminGrowthOperations || !client) return;

		const result = await getAdminGrowthOperations(
			{
				from,
				to,
				generationEnabled: true,
				productKey: "image-quality",
				provider: "fal",
				model: "model-quality",
				status: "FAILED",
			},
			client,
		);

		expect(result.summary).toMatchObject({
			jobs: 1,
			succeeded: 0,
			failed: 1,
			successRate: 0,
			averageProviderCostMicros: "100000",
		});
		expect(result.failureCodes).toEqual([{ code: "PROVIDER_FAILED", count: 1 }]);
		expect(result.routes).toEqual([
			{
				productKey: "image-quality",
				provider: "fal",
				model: "model-quality",
				status: "FAILED",
				jobs: 1,
			},
		]);
	});

	it("coalesces a non-code failure value without returning its raw text", async () => {
		expect(getAdminGrowthOperations).toBeTypeOf("function");
		if (!getAdminGrowthOperations || !client) return;
		const unsafeFailure = "https://private.example/failure?signature=fixture";
		await client.generationJob.update({
			where: { id: jobIds[2]! },
			data: { failureCode: unsafeFailure },
		});

		try {
			const result = await getAdminGrowthOperations({ from, to, generationEnabled: true }, client);

			expect(result.failureCodes).toContainEqual({ code: "UNCLASSIFIED_FAILURE", count: 1 });
			expect(JSON.stringify(result)).not.toContain(unsafeFailure);
		} finally {
			await client.generationJob.update({
				where: { id: jobIds[2]! },
				data: { failureCode: "PROVIDER_FAILED" },
			});
		}
	});

	async function seedFixtures(database: PrismaClient) {
		await database.creditAccount.create({
			data: {
				id: accountId,
				ownerType: "USER",
				ownerId,
				spendableCredits: 100n,
				reservedCredits: 10n,
			},
		});
		await database.imageEditSession.createMany({
			data: [
				{ id: sessionIds[0], ownerType: "USER", ownerId, rootAssetId: assetIds[0] },
				{ id: sessionIds[1], ownerType: "USER", ownerId, rootAssetId: assetIds[2] },
			],
		});
		for (const [index, quoteId] of quoteIds.entries()) {
			await database.generationQuote.create({
				data: {
					id: quoteId,
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					productKey: index === 0 || index === 3 ? "image-fast" : "image-quality",
					catalogVersion: "2099-01-01",
					pricingVersion: "2099-01-01",
					credits: index === 0 || index === 3 ? 10n : 20n,
					costMicros: 0n,
					inputSnapshot: { prompt: `private-${suffix}-${index}` },
					pricingSnapshot: { internal: true },
					moderationDecision: "ALLOW",
					moderationProvider: "test",
					moderationRuleVersion: "growth-test-v1",
					moderationReasonCode: "ALLOW",
					inputFingerprint: "a".repeat(64),
					createdAt: new Date(`2099-01-0${index + 2}T10:00:00.000Z`),
					expiresAt: new Date("2099-03-01T00:00:00.000Z"),
				},
			});
		}
		const statuses = ["SUCCEEDED", "SUCCEEDED", "FAILED", "PROVIDER_RUNNING"] as const;
		for (const [index, jobId] of jobIds.entries()) {
			const createdAt = new Date(`2099-01-0${index + 2}T10:00:00.000Z`);
			await database.generationJob.create({
				data: {
					id: jobId,
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					quoteId: quoteIds[index]!,
					idempotencyKey: `growth-job-${suffix}-${index}`,
					productKey: index === 0 || index === 3 ? "image-fast" : "image-quality",
					catalogVersion: "2099-01-01",
					pricingVersion: "2099-01-01",
					creditsReserved: index === 0 || index === 3 ? 10n : 20n,
					inputSnapshot: { privatePrompt: `must-not-return-${index}` },
					pricingSnapshot: { internalCost: 999 },
					status: statuses[index]!,
					failureCode: index === 2 ? "PROVIDER_FAILED" : null,
					createdAt,
					updatedAt: new Date(createdAt.getTime() + (index + 1) * 1_000),
					terminalAt: index < 3 ? new Date(createdAt.getTime() + 30_000) : null,
					editSessionId: index < 2 ? sessionIds[0] : index === 2 ? sessionIds[1] : null,
					parentJobId: index === 1 ? jobIds[0] : null,
				},
			});
		}
		const attemptData = [
			{ provider: "fal", model: "model-standard", status: "SUCCEEDED", cost: 100_000n, ms: 2_000 },
			{
				provider: "replicate",
				model: "model-quality",
				status: "SUCCEEDED",
				cost: 300_000n,
				ms: 8_000,
			},
			{ provider: "fal", model: "model-quality", status: "FAILED", cost: 100_000n, ms: 20_000 },
			{ provider: "fal", model: "model-standard", status: "RUNNING", cost: null, ms: null },
		] as const;
		for (const [index, attempt] of attemptData.entries()) {
			const submittedAt = new Date(`2099-01-0${index + 2}T10:00:01.000Z`);
			await database.generationAttempt.create({
				data: {
					id: `growth-attempt-${index}-${suffix}`,
					jobId: jobIds[index]!,
					attemptNumber: 1,
					provider: attempt.provider,
					providerModelId: attempt.model,
					status: attempt.status,
					providerCostMicros: attempt.cost,
					requestSnapshot: { prompt: `private-attempt-${index}` },
					responseSnapshot: { signedUrl: "https://private.example/output?token=secret" },
					createdAt: submittedAt,
					updatedAt: attempt.ms ? new Date(submittedAt.getTime() + attempt.ms) : submittedAt,
					submittedAt,
					completedAt: attempt.ms ? new Date(submittedAt.getTime() + attempt.ms) : null,
				},
			});
			await database.creditReservation.create({
				data: {
					id: `growth-reservation-${index}-${suffix}`,
					accountId,
					jobId: jobIds[index]!,
					amount: index === 0 || index === 3 ? 10n : 20n,
					settledAmount: index < 2 ? (index === 0 ? 10n : 20n) : 0n,
					releasedAmount: index === 2 ? 20n : 0n,
					status: index < 2 ? "SETTLED" : index === 2 ? "RELEASED" : "ACTIVE",
					createdAt: submittedAt,
				},
			});
		}
		for (const [index, assetId] of assetIds.entries()) {
			await database.mediaAsset.create({
				data: {
					id: assetId,
					ownerType: "USER",
					ownerId,
					kind: "INPUT",
					status: "VERIFYING",
					objectKey: `private/growth/${suffix}/${index}.png`,
					mimeType: "image/png",
					byteSize: 1_024n,
					checksum: "b".repeat(64),
					createdAt: new Date(`2099-01-0${index + 2}T09:00:00.000Z`),
				},
			});
			await database.generationJobAsset.create({
				data: {
					jobId: jobIds[index]!,
					assetId,
					assetChecksum: "b".repeat(64),
					role: "INPUT",
				},
			});
			await database.assetModerationResult.create({
				data: {
					assetId,
					assetChecksum: "b".repeat(64),
					verificationGeneration: 0,
					attemptNumber: 1,
					evidenceKind: "INPUT",
					provider: "test-moderation",
					ruleVersion: "growth-test-v1",
					policyVersion: "growth-test-v1",
					status: index === 1 ? "REJECTED" : "APPROVED",
					reasonCode: index === 1 ? "POLICY_REJECTED" : "ALLOW",
					categories: { private: "must-not-return" },
					rawEnvelope: { signedUrl: "https://private.example/moderation" },
					validUntil: new Date("2100-01-01T00:00:00.000Z"),
					createdAt: new Date(`2099-01-0${index + 2}T09:30:00.000Z`),
				},
			});
		}
		await database.runtimeConfigOverride.create({
			data: {
				id: `growth-override-${suffix}`,
				configKey: "media.model.image-quality.enabled",
				version: 2_000_000_000,
				value: false,
				active: true,
				reason: "growth operations fixture",
				createdByUserId: `growth-admin-${suffix}`,
			},
		});
	}
});

async function truncateDedicatedGrowthFixtures(client: PrismaClient) {
	const [database] = await client.$queryRaw<Array<{ name: string }>>`
		SELECT current_database()::text AS name`;
	if (!database?.name || !approvedGrowthTestDatabases.has(database.name)) {
		throw new Error("UNSAFE_TEST_DATABASE");
	}
	await client.$executeRawUnsafe(`
		TRUNCATE TABLE
			"asset_moderation_result",
			"generation_job_asset",
			"media_asset",
			"generation_attempt",
			"credit_reservation",
			"generation_job",
			"image_edit_session",
			"generation_quote",
			"credit_account",
			"runtime_config_override"
		CASCADE
	`);
}
