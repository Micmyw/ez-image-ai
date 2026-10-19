import { PrismaPg } from "@prisma/adapter-pg";
import { createCreditGrant, getCreditInvariantReport } from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { executeMediaLoadRequest, type LoadTestConfiguration } from "./media-load";

const TEST_DATABASE_URL = assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const RUN_ID = `load-${crypto.randomUUID()}`;
const OWNER_ID = `load-test:${RUN_ID}`;
const configuration: LoadTestConfiguration = {
	authToken: "not-used-by-database-boundary",
	runId: RUN_ID,
	ownerId: OWNER_ID,
	rateLimitPerMinute: 100,
	concurrencyLimit: 10,
	creditGrant: 1_000n,
};

describe("controlled media load database path", () => {
	let client: PrismaClient;

	beforeAll(async () => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }),
		});
		// These requests exercise an already funded owner, not concurrent account provisioning.
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId: OWNER_ID },
		});
		await createCreditGrant(
			{
				accountId: account.id,
				amount: configuration.creditGrant,
				referenceKey: `load-test:${RUN_ID}:grant`,
				metadata: { source: "controlled-load-test", runId: RUN_ID },
			},
			client,
		);
		// The obsolete project setting must not limit real claims, even with prior pending work.
		vi.stubEnv("VIDEO_RUNTIME_CONFIG", undefined);
		vi.stubEnv("VIDEO_V1_PROVIDER_CONCURRENCY", "2");
	});

	afterAll(async () => {
		try {
			await client?.$disconnect();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("starts three simultaneous funded mock requests while the old project setting is two", async () => {
		await withoutExternalProviderConfiguration(async () => {
			const results = await Promise.all(
				Array.from({ length: 3 }, (_, index) =>
					executeMediaLoadRequest(
						{ mode: "long", idempotencyKey: `k6:${RUN_ID}:retired-cap:${index}` },
						configuration,
					),
				),
			);
			expect(new Set(results.map(({ jobId }) => jobId)).size).toBe(3);
			expect(results.map(({ status }) => status)).toEqual([
				"PROVIDER_PENDING",
				"PROVIDER_PENDING",
				"PROVIDER_PENDING",
			]);
			const jobs = await client.generationJob.findMany({
				where: { id: { in: results.map(({ jobId }) => jobId) } },
				include: { attempts: true, reservation: true },
			});
			expect(jobs).toHaveLength(3);
			for (const job of jobs) {
				expect(job.reservation).toMatchObject({ amount: 5n, status: "ACTIVE" });
				expect(job.attempts).toEqual([
					expect.objectContaining({
						status: "SUBMITTED",
						providerTaskId: expect.stringMatching(/^load-test-/),
						uncertainSubmission: false,
					}),
				]);
			}
			const account = await client.creditAccount.findUniqueOrThrow({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: OWNER_ID } },
			});
			expect(await getCreditInvariantReport(account.id, client)).toMatchObject({ valid: true });
		});
	});

	it("creates one quote, reserved job, ledger reservation, attempt and outbox path", async () => {
		const idempotencyKey = `k6:${RUN_ID}:1:1`;
		const result = await withoutExternalProviderConfiguration(() =>
			executeMediaLoadRequest({ mode: "fast", idempotencyKey }, configuration),
		);
		const job = await client.generationJob.findUniqueOrThrow({
			where: { id: result.jobId },
			include: {
				quote: true,
				reservation: true,
				attempts: true,
				assets: { include: { asset: true } },
			},
		});
		const account = await client.creditAccount.findUniqueOrThrow({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId: OWNER_ID } },
		});
		const outbox = await client.outboxEvent.findMany({
			where: { aggregateId: job.id },
			orderBy: { createdAt: "asc" },
		});

		expect(result).toMatchObject({
			idempotencyKey,
			mode: "fast",
			replayed: false,
			status: "FINALIZING",
		});
		expect(job).toMatchObject({
			ownerId: OWNER_ID,
			creditsReserved: 5n,
			inputSnapshot: {
				kind: "image-to-image",
				skuKey: "nano-banana-2-lite-1k",
				aspectRatio: "auto",
			},
			quote: { ownerId: OWNER_ID, productKey: "image-nano-banana-2-lite" },
			reservation: { amount: 5n, status: "ACTIVE" },
			assets: [
				expect.objectContaining({
					role: "INPUT",
					asset: expect.objectContaining({
						ownerId: OWNER_ID,
						status: "READY",
						mimeType: "image/png",
					}),
				}),
			],
			attempts: [
				expect.objectContaining({
					status: "SUCCEEDED",
					providerTaskId: expect.stringMatching(/^load-test-/),
					providerCostMicros: 0n,
				}),
			],
		});
		expect((job.inputSnapshot as { sourceAssetId?: string }).sourceAssetId).toBe(
			job.assets[0]?.assetId,
		);
		expect(job.quote.pricingSnapshot).toMatchObject({
			skuKey: "nano-banana-2-lite-1k",
			routeGraph: {
				graphFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
				maximumRouteCostMicros: 20_000,
				allowedRoutes: [
					{
						provider: "kie",
						providerModelId: "nano-banana-2-lite",
						providerCostMicros: 20_000,
					},
				],
			},
		});
		expect(outbox.map((event) => event.eventType)).toEqual(["JOB_CREATED", "GENERATION_FINALIZE"]);
		expect(
			await client.creditLedgerEntry.count({
				where: { accountId: account.id, reservationId: job.reservation!.id, type: "RESERVE" },
			}),
		).toBe(1);
		expect(await getCreditInvariantReport(account.id, client)).toMatchObject({ valid: true });
	});

	it("replays the same command without an extra job, reservation, attempt or grant", async () => {
		const idempotencyKey = `k6:${RUN_ID}:2:1`;
		const first = await executeMediaLoadRequest({ mode: "long", idempotencyKey }, configuration);
		const replay = await executeMediaLoadRequest({ mode: "long", idempotencyKey }, configuration);
		expect(replay).toMatchObject({
			jobId: first.jobId,
			replayed: true,
			status: "PROVIDER_PENDING",
		});
		expect(await client.generationJob.count({ where: { ownerId: OWNER_ID, idempotencyKey } })).toBe(
			1,
		);
		expect(await client.creditReservation.count({ where: { jobId: first.jobId } })).toBe(1);
		expect(await client.generationAttempt.count({ where: { jobId: first.jobId } })).toBe(1);
		expect(
			await client.creditLedgerEntry.count({
				where: { referenceKey: `load-test:${RUN_ID}:grant` },
			}),
		).toBe(1);
	});

	it("contains deterministic provider failure and uncertainty inside the test database", async () => {
		const failure = await executeMediaLoadRequest(
			{ mode: "provider-fail", idempotencyKey: `k6:${RUN_ID}:3:1` },
			configuration,
		);
		const uncertain = await executeMediaLoadRequest(
			{ mode: "uncertain", idempotencyKey: `k6:${RUN_ID}:4:1` },
			configuration,
		);
		expect(failure.status).toBe("FINALIZING");
		expect(uncertain.status).toBe("PROVIDER_PENDING");
		await expect(
			client.generationAttempt.findFirstOrThrow({ where: { jobId: failure.jobId } }),
		).resolves.toMatchObject({ status: "FAILED" });
		await expect(
			client.generationAttempt.findFirstOrThrow({ where: { jobId: uncertain.jobId } }),
		).resolves.toMatchObject({ status: "SUBMISSION_UNCERTAIN", uncertainSubmission: true });
	});
});

const EXTERNAL_PROVIDER_ENVIRONMENT_KEYS = [
	"MEDIA_ENABLED_PROVIDERS",
	"MEDIA_PROVIDER_ADAPTER",
	"REPLICATE_API_TOKEN",
	"FAL_API_KEY",
	"KIE_API_KEY",
	"GEMINI_API_KEY",
] as const;

async function withoutExternalProviderConfiguration<T>(operation: () => Promise<T>): Promise<T> {
	const previous = new Map(
		EXTERNAL_PROVIDER_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]] as const),
	);
	for (const key of EXTERNAL_PROVIDER_ENVIRONMENT_KEYS) delete process.env[key];
	try {
		return await operation();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function assertSafeTestDatabaseUrl(value: string | undefined): string {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	const databaseName = decodeURIComponent(parsed.pathname.slice(1));
	if (
		!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) ||
		!/test|testing/i.test(databaseName)
	) {
		throw new Error("TEST_DATABASE_URL must use a loopback test database");
	}
	return value;
}
