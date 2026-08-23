import { PrismaPg } from "@prisma/adapter-pg";
import { getCreditInvariantReport } from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("creates one quote, reserved job, ledger reservation, attempt and outbox path", async () => {
		const idempotencyKey = `k6:${RUN_ID}:1:1`;
		const result = await executeMediaLoadRequest({ mode: "fast", idempotencyKey }, configuration);
		const job = await client.generationJob.findUniqueOrThrow({
			where: { id: result.jobId },
			include: { quote: true, reservation: true, attempts: true },
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
			creditsReserved: 4n,
			quote: { ownerId: OWNER_ID, productKey: "image-fast" },
			reservation: { amount: 4n, status: "ACTIVE" },
			attempts: [
				expect.objectContaining({
					status: "SUCCEEDED",
					providerTaskId: expect.stringMatching(/^load-test-/),
					providerCostMicros: 0n,
				}),
			],
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
