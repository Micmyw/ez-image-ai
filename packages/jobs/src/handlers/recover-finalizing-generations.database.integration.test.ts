import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	FINALIZATION_RECOVERY_EXHAUSTED_ACTION,
	FINALIZATION_RECOVERY_EXHAUSTED_CODE,
	FINALIZATION_RECOVERY_MAX_ATTEMPTS,
	createDatabaseFinalizingGenerationRecoveryStore,
} from "./finalization-recovery-store";
import { recoverFinalizingGenerations } from "./recover-finalizing-generations";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-08-24T08:00:00.000Z");
const STALE_BEFORE = new Date("2026-08-24T07:55:00.000Z");
const TEST_PREFIX = `finalization-recovery-${crypto.randomUUID()}`;

let client: PrismaClient;

describe("database finalizing-generation recovery", () => {
	beforeAll(() => {
		assertSafeTestDatabaseUrl(TEST_DATABASE_URL);
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }),
		});
	});

	afterAll(async () => {
		if (!client) return;
		const jobs = await client.generationJob.findMany({
			where: { ownerId: { startsWith: TEST_PREFIX } },
			select: { id: true },
		});
		const jobIds = jobs.map((job) => job.id);
		await client.$transaction([
			client.outboxEvent.deleteMany({ where: { aggregateId: { in: jobIds } } }),
			client.auditLog.deleteMany({
				where: { targetType: "GENERATION_JOB", targetId: { in: jobIds } },
			}),
			client.generationAttempt.deleteMany({ where: { jobId: { in: jobIds } } }),
			client.creditReservation.deleteMany({ where: { jobId: { in: jobIds } } }),
			client.generationJob.deleteMany({ where: { id: { in: jobIds } } }),
			client.generationQuote.deleteMany({
				where: { ownerId: { startsWith: TEST_PREFIX } },
			}),
			client.creditAccount.deleteMany({
				where: { ownerId: { startsWith: TEST_PREFIX } },
			}),
		]);
		await client.$disconnect();
	});

	it("scans due or stale FINALIZING jobs and CANCELED jobs with active reservations", async () => {
		const store = createDatabaseFinalizingGenerationRecoveryStore(client);
		const due = await seedCandidate({ nextFinalizeAt: new Date(NOW.getTime() - 1_000) });
		const stale = await seedCandidate({ nextFinalizeAt: null, updatedAt: STALE_BEFORE });
		const canceled = await seedCandidate({ status: "CANCELED", reservationStatus: "ACTIVE" });
		const future = await seedCandidate({ nextFinalizeAt: new Date(NOW.getTime() + 60_000) });
		const fresh = await seedCandidate({ nextFinalizeAt: null, updatedAt: NOW });
		const released = await seedCandidate({
			status: "CANCELED",
			reservationStatus: "RELEASED",
		});

		const candidates = await store.listCandidates({
			limit: 25,
			now: NOW,
			staleBefore: STALE_BEFORE,
		});
		const candidateIds = new Set(candidates.map((candidate) => candidate.jobId));

		expect(candidateIds).toContain(due.jobId);
		expect(candidateIds).toContain(stale.jobId);
		expect(candidateIds).toContain(canceled.jobId);
		expect(candidateIds).not.toContain(future.jobId);
		expect(candidateIds).not.toContain(fresh.jobId);
		expect(candidateIds).not.toContain(released.jobId);
	});

	it("scans an unaudited exhausted job once and excludes an already-audited exhaustion", async () => {
		const store = createDatabaseFinalizingGenerationRecoveryStore(client);
		const unaudited = await seedCandidate({
			finalizationRetryCount: FINALIZATION_RECOVERY_MAX_ATTEMPTS,
		});
		const audited = await seedCandidate({
			finalizationRetryCount: FINALIZATION_RECOVERY_MAX_ATTEMPTS,
			finalizationErrorCode: FINALIZATION_RECOVERY_EXHAUSTED_CODE,
		});

		const candidates = await store.listCandidates({
			limit: 100,
			now: NOW,
			staleBefore: STALE_BEFORE,
		});
		const candidateIds = new Set(candidates.map((candidate) => candidate.jobId));

		expect(candidateIds).toContain(unaudited.jobId);
		expect(candidateIds).not.toContain(audited.jobId);
	});

	it("keeps a durable SETTLE route when any historical settle outbox checkpoint exists", async () => {
		const store = createDatabaseFinalizingGenerationRecoveryStore(client);
		const seeded = await seedCandidate({ succeededAttempt: true });
		await createOutbox(seeded.jobId, "GENERATION_SETTLE", "PROCESSED");

		await expect(
			store.recoverCandidate({ jobId: seeded.jobId }, { now: NOW, staleBefore: STALE_BEFORE }),
		).resolves.toBe("RECOVERED");

		await expect(recoveryOutboxes(seeded.jobId)).resolves.toEqual([
			expect.objectContaining({
				eventType: "GENERATION_SETTLE",
				payload: expect.objectContaining({ recoveryRoute: "SETTLE", recoveryAttempt: 1 }),
			}),
		]);
		await expect(recoveryState(seeded.jobId)).resolves.toMatchObject({
			finalizationRetryCount: 1,
			finalizationErrorCode: "SETTLEMENT_RECOVERY_QUEUED",
		});
	});

	it("routes a successful provider attempt back through FINALIZE when no settle checkpoint exists", async () => {
		const store = createDatabaseFinalizingGenerationRecoveryStore(client);
		const seeded = await seedCandidate({ succeededAttempt: true });

		await expect(
			store.recoverCandidate({ jobId: seeded.jobId }, { now: NOW, staleBefore: STALE_BEFORE }),
		).resolves.toBe("RECOVERED");

		await expect(recoveryOutboxes(seeded.jobId)).resolves.toEqual([
			expect.objectContaining({
				eventType: "GENERATION_FINALIZE_RETRY",
				payload: expect.objectContaining({ recoveryRoute: "FINALIZE", recoveryAttempt: 1 }),
			}),
		]);
	});

	it("routes a job without a successful provider attempt through SETTLE", async () => {
		const store = createDatabaseFinalizingGenerationRecoveryStore(client);
		const seeded = await seedCandidate();

		await expect(
			store.recoverCandidate({ jobId: seeded.jobId }, { now: NOW, staleBefore: STALE_BEFORE }),
		).resolves.toBe("RECOVERED");
		await expect(recoveryOutboxes(seeded.jobId)).resolves.toEqual([
			expect.objectContaining({ eventType: "GENERATION_SETTLE" }),
		]);
	});

	it("always settles a canceled job that still owns an active reservation", async () => {
		const store = createDatabaseFinalizingGenerationRecoveryStore(client);
		const seeded = await seedCandidate({
			status: "CANCELED",
			reservationStatus: "ACTIVE",
			succeededAttempt: true,
		});

		await expect(
			store.recoverCandidate({ jobId: seeded.jobId }, { now: NOW, staleBefore: STALE_BEFORE }),
		).resolves.toBe("RECOVERED");
		await expect(recoveryOutboxes(seeded.jobId)).resolves.toEqual([
			expect.objectContaining({ eventType: "GENERATION_SETTLE" }),
		]);
	});

	it.each(["PENDING", "LEASED"] as const)(
		"skips an active %s event in the selected recovery class without consuming an attempt",
		async (status) => {
			const store = createDatabaseFinalizingGenerationRecoveryStore(client);
			const finalize = await seedCandidate({ succeededAttempt: true });
			const settle = await seedCandidate();
			await createOutbox(finalize.jobId, "GENERATION_FINALIZE", status);
			await createOutbox(settle.jobId, "GENERATION_SETTLE", status);

			await expect(
				Promise.all([
					store.recoverCandidate(
						{ jobId: finalize.jobId },
						{ now: NOW, staleBefore: STALE_BEFORE },
					),
					store.recoverCandidate({ jobId: settle.jobId }, { now: NOW, staleBefore: STALE_BEFORE }),
				]),
			).resolves.toEqual(["SKIPPED", "SKIPPED"]);
			await expect(recoveryState(finalize.jobId)).resolves.toMatchObject({
				finalizationRetryCount: 0,
			});
			await expect(recoveryState(settle.jobId)).resolves.toMatchObject({
				finalizationRetryCount: 0,
			});
			expect(await recoveryOutboxes(finalize.jobId)).toHaveLength(0);
			expect(await recoveryOutboxes(settle.jobId)).toHaveLength(0);
		},
	);

	it.each(["PROCESSED", "DEAD_LETTER"] as const)(
		"allows a new FINALIZE recovery after a %s event",
		async (status) => {
			const store = createDatabaseFinalizingGenerationRecoveryStore(client);
			const seeded = await seedCandidate({ succeededAttempt: true });
			await createOutbox(seeded.jobId, "GENERATION_FINALIZE", status);

			await expect(
				store.recoverCandidate({ jobId: seeded.jobId }, { now: NOW, staleBefore: STALE_BEFORE }),
			).resolves.toBe("RECOVERED");
			await expect(recoveryOutboxes(seeded.jobId)).resolves.toEqual([
				expect.objectContaining({ eventType: "GENERATION_FINALIZE_RETRY" }),
			]);
		},
	);

	it("creates one outbox event and increments the retry count once under concurrent recovery", async () => {
		const store = createDatabaseFinalizingGenerationRecoveryStore(client);
		const seeded = await seedCandidate({ succeededAttempt: true });

		const outcomes = await Promise.all([
			store.recoverCandidate({ jobId: seeded.jobId }, { now: NOW, staleBefore: STALE_BEFORE }),
			store.recoverCandidate({ jobId: seeded.jobId }, { now: NOW, staleBefore: STALE_BEFORE }),
		]);

		expect(outcomes.sort()).toEqual(["RECOVERED", "SKIPPED"]);
		expect(await recoveryOutboxes(seeded.jobId)).toHaveLength(1);
		await expect(recoveryState(seeded.jobId)).resolves.toMatchObject({
			finalizationRetryCount: 1,
		});
	});

	it("permits the eighth recovery attempt and schedules the next durable backoff", async () => {
		const store = createDatabaseFinalizingGenerationRecoveryStore(client);
		const seeded = await seedCandidate({ succeededAttempt: true, finalizationRetryCount: 7 });

		await expect(
			store.recoverCandidate({ jobId: seeded.jobId }, { now: NOW, staleBefore: STALE_BEFORE }),
		).resolves.toBe("RECOVERED");
		await expect(recoveryState(seeded.jobId)).resolves.toMatchObject({
			finalizationRetryCount: FINALIZATION_RECOVERY_MAX_ATTEMPTS,
			nextFinalizeAt: new Date(NOW.getTime() + 60 * 60_000),
		});
	});

	it("stops after eight attempts and writes the exhaustion audit exactly once", async () => {
		const store = createDatabaseFinalizingGenerationRecoveryStore(client);
		const seeded = await seedCandidate({
			succeededAttempt: true,
			finalizationRetryCount: FINALIZATION_RECOVERY_MAX_ATTEMPTS,
		});

		await expect(
			Promise.all([
				store.recoverCandidate({ jobId: seeded.jobId }, { now: NOW, staleBefore: STALE_BEFORE }),
				store.recoverCandidate({ jobId: seeded.jobId }, { now: NOW, staleBefore: STALE_BEFORE }),
			]),
		).resolves.toEqual(["EXHAUSTED", "EXHAUSTED"]);
		expect(await recoveryOutboxes(seeded.jobId)).toHaveLength(0);
		await expect(recoveryState(seeded.jobId)).resolves.toMatchObject({
			finalizationRetryCount: FINALIZATION_RECOVERY_MAX_ATTEMPTS,
			finalizationErrorCode: FINALIZATION_RECOVERY_EXHAUSTED_CODE,
			nextFinalizeAt: null,
		});
		expect(
			await client.auditLog.count({
				where: {
					action: FINALIZATION_RECOVERY_EXHAUSTED_ACTION,
					targetType: "GENERATION_JOB",
					targetId: seeded.jobId,
				},
			}),
		).toBe(1);
	});

	it("rolls back a failed candidate and continues recovering later candidates", async () => {
		const store = createDatabaseFinalizingGenerationRecoveryStore(client);
		const broken = await seedCandidate({ succeededAttempt: true });
		const healthy = await seedCandidate({ succeededAttempt: true });
		await createOutbox(
			broken.jobId,
			"GENERATION_FINALIZE_RETRY",
			"PROCESSED",
			`generation-recovery:${broken.jobId}:finalize:1`,
		);

		await expect(
			recoverFinalizingGenerations(
				{ limit: 25 },
				{
					...store,
					listCandidates: async () => [{ jobId: broken.jobId }, { jobId: healthy.jobId }],
					now: () => NOW,
				},
			),
		).resolves.toEqual({ scanned: 2, recovered: 1, skipped: 0, exhausted: 0, failed: 1 });
		await expect(recoveryState(broken.jobId)).resolves.toMatchObject({
			finalizationRetryCount: 0,
		});
		await expect(recoveryState(healthy.jobId)).resolves.toMatchObject({
			finalizationRetryCount: 1,
		});
	});
});

interface SeedCandidateOptions {
	status?: "FINALIZING" | "CANCELED";
	reservationStatus?: "ACTIVE" | "SETTLED" | "RELEASED";
	succeededAttempt?: boolean;
	finalizationRetryCount?: number;
	finalizationErrorCode?: string | null;
	nextFinalizeAt?: Date | null;
	updatedAt?: Date;
}

async function seedCandidate(options: SeedCandidateOptions = {}): Promise<{ jobId: string }> {
	const suffix = crypto.randomUUID();
	const ownerId = `${TEST_PREFIX}-${suffix}`;
	const account = await client.creditAccount.create({
		data: { ownerType: "USER", ownerId, reservedCredits: 4n },
	});
	const quote = await client.generationQuote.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-fast",
			catalogVersion: "finalization-recovery-test",
			pricingVersion: "finalization-recovery-test",
			credits: 4n,
			costMicros: 1_000n,
			inputSnapshot: { prompt: "recovery test" },
			pricingSnapshot: { credits: 4 },
			expiresAt: new Date(NOW.getTime() + 60_000),
		},
	});
	const job = await client.generationJob.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `recovery-${suffix}`,
			productKey: "image-fast",
			catalogVersion: "finalization-recovery-test",
			pricingVersion: "finalization-recovery-test",
			creditsReserved: 4n,
			inputSnapshot: { prompt: "recovery test" },
			pricingSnapshot: { credits: 4 },
			status: options.status ?? "FINALIZING",
			finalizationRetryCount: options.finalizationRetryCount ?? 0,
			finalizationErrorCode: options.finalizationErrorCode,
			nextFinalizeAt:
				options.nextFinalizeAt === undefined
					? new Date(NOW.getTime() - 60_000)
					: options.nextFinalizeAt,
			terminalAt: options.status === "CANCELED" ? NOW : null,
		},
	});
	if (options.reservationStatus !== undefined || options.status !== "CANCELED") {
		await client.creditReservation.create({
			data: {
				accountId: account.id,
				jobId: job.id,
				amount: 4n,
				status: options.reservationStatus ?? "ACTIVE",
			},
		});
	}
	if (options.succeededAttempt) {
		await client.generationAttempt.create({
			data: {
				jobId: job.id,
				attemptNumber: 1,
				provider: "replicate",
				providerModelId: "recovery-test-model",
				status: "SUCCEEDED",
				requestSnapshot: {},
				responseSnapshot: { outputs: [] },
				completedAt: NOW,
			},
		});
	}
	if (options.updatedAt) {
		await client.generationJob.update({
			where: { id: job.id },
			data: { updatedAt: options.updatedAt },
		});
	}
	return { jobId: job.id };
}

async function createOutbox(
	jobId: string,
	eventType: string,
	status: "PENDING" | "LEASED" | "PROCESSED" | "DEAD_LETTER",
	dedupeKey = `test-history:${jobId}:${eventType}:${status}:${crypto.randomUUID()}`,
): Promise<void> {
	await client.outboxEvent.create({
		data: {
			eventType,
			aggregateType: "GENERATION_JOB",
			aggregateId: jobId,
			dedupeKey,
			payload: { jobId },
			status,
			...(status === "LEASED"
				? {
						leaseOwner: "integration-test",
						leaseToken: crypto.randomUUID(),
						leasedUntil: new Date(NOW.getTime() + 60_000),
					}
				: {}),
			...(status === "PROCESSED" ? { processedAt: NOW } : {}),
			...(status === "DEAD_LETTER" ? { lastError: "TEST_TERMINAL_FAILURE" } : {}),
		},
	});
}

function recoveryOutboxes(jobId: string) {
	return client.outboxEvent.findMany({
		where: { aggregateId: jobId, dedupeKey: { startsWith: `generation-recovery:${jobId}:` } },
		orderBy: { createdAt: "asc" },
	});
}

function recoveryState(jobId: string) {
	return client.generationJob.findUniqueOrThrow({
		where: { id: jobId },
		select: {
			finalizationRetryCount: true,
			finalizationErrorCode: true,
			nextFinalizeAt: true,
		},
	});
}

function assertSafeTestDatabaseUrl(value: string | undefined): void {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	if (
		parsed.hostname !== "127.0.0.1" ||
		parsed.port !== "55432" ||
		!parsed.pathname.toLowerCase().includes("test")
	) {
		throw new Error("TEST_DATABASE_URL must target a test database on 127.0.0.1:55432");
	}
}
