import { PrismaPg } from "@prisma/adapter-pg";
import { claimGenerationOutputTransferTransaction } from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FinalizationClaim, FinalizationStore } from "../contracts";
import { createDatabaseFinalizationStore } from "../runtime";

let client: PrismaClient;
const jobIds: string[] = [];
const quoteIds: string[] = [];
const assetIds: string[] = [];
const methods = ["recordFinalizationWait", "recordFinalization"] as const;
type RecordMethod = (typeof methods)[number];
type OutputClaim = Parameters<typeof claimGenerationOutputTransferTransaction>[0];

beforeAll(() => {
	const value = process.env.TEST_DATABASE_URL;
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const url = new URL(value);
	if (
		!["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
		url.port !== "55432" ||
		!/(^|[_-])(test|testing)([_-]|$)/u.test(url.pathname.slice(1)) ||
		["postgres", "template0", "template1"].includes(url.pathname.slice(1))
	) {
		throw new Error("TEST_DATABASE_URL must target a local test database on port 55432");
	}
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString: value }) });
});

beforeEach(() => vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
	if (!client) return;
	try {
		await client.outboxEvent.deleteMany({ where: { aggregateId: { in: jobIds } } });
		await client.generationJobAsset.deleteMany({ where: { jobId: { in: jobIds } } });
		await client.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
		await client.generationJob.deleteMany({ where: { id: { in: jobIds } } });
		await client.generationQuote.deleteMany({ where: { id: { in: quoteIds } } });
	} finally {
		await client.$disconnect();
	}
});

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((done, failed) => {
		resolve = done;
		reject = failed;
	});
	return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("FINALIZATION_LOCK_TEST_TIMEOUT")), 3_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function holdJob(jobId: string, terminal = false) {
	const ready = deferred();
	const release = deferred();
	let pid = 0;
	const operation = client.$transaction(
		async (tx) => {
			const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
			pid = backend!.pid;
			await tx.$queryRaw`SELECT id FROM generation_job WHERE id = ${jobId} FOR UPDATE`;
			if (terminal) {
				await tx.generationJob.update({ where: { id: jobId }, data: { status: "FAILED" } });
			}
			ready.resolve();
			await release.promise;
		},
		{ timeout: 10_000 },
	);
	void operation.catch(ready.reject);
	try {
		await bounded(ready.promise);
	} catch (error) {
		release.resolve();
		await Promise.allSettled([operation]);
		throw error;
	}
	return { pid, release: release.resolve, operation };
}

async function waitForBlocked(pid: number, minimum: number) {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const blocked = await client.$queryRaw<Array<{ pid: number; query: string }>>`
			WITH RECURSIVE waiters AS (
				SELECT pid, query FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
				UNION
				SELECT activity.pid, activity.query FROM pg_stat_activity AS activity
				JOIN waiters ON waiters.pid = ANY(pg_blocking_pids(activity.pid))
			)
			SELECT pid, query FROM waiters
		`;
		if (blocked.length >= minimum) return blocked;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("FINALIZATION_DID_NOT_WAIT_FOR_JOB_LOCK");
}

async function fixture() {
	const suffix = crypto.randomUUID();
	const jobId = `finalization-lock-job-${suffix}`;
	const quoteId = `finalization-lock-quote-${suffix}`;
	const ownerId = `finalization-lock-owner-${suffix}`;
	const assetId = `finalization-lock-asset-${suffix}`;
	const candidateKey = `${suffix}:0`;
	const objectKey = `users/${ownerId}/assets/${assetId}/original.png`;
	jobIds.push(jobId);
	quoteIds.push(quoteId);
	assetIds.push(assetId);
	await client.generationQuote.create({
		data: {
			id: quoteId,
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-nano-banana-2-lite",
			catalogVersion: "lock-test",
			pricingVersion: "lock-test",
			credits: 1n,
			costMicros: 1n,
			inputSnapshot: {},
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60_000),
		},
	});
	await client.generationJob.create({
		data: {
			id: jobId,
			quoteId,
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			idempotencyKey: jobId,
			productKey: "image-nano-banana-2-lite",
			catalogVersion: "lock-test",
			pricingVersion: "lock-test",
			creditsReserved: 1n,
			inputSnapshot: {},
			pricingSnapshot: {},
			status: "FINALIZING",
			executionEngine: "legacy",
		},
	});
	await client.mediaAsset.create({
		data: {
			id: assetId,
			ownerType: "USER",
			ownerId,
			kind: "OUTPUT",
			status: "VERIFYING",
			objectKey,
			mimeType: "image/png",
			byteSize: 0n,
			sourceUrl: `provider-output:${candidateKey}`,
		},
	});
	await client.generationJobAsset.create({
		data: {
			jobId,
			assetId,
			assetChecksum: `pending-output:${assetId}`,
			role: "OUTPUT",
			position: 9,
		},
	});
	const claim: FinalizationClaim = {
		jobId,
		ownerId,
		mediaKind: "image",
		candidates: [
			{
				key: candidateKey,
				output: {
					kind: "remote-url",
					url: "https://provider.example/output.png",
					trust: "untrusted-transfer-candidate",
				},
			},
		],
	};
	const transfer: OutputClaim = {
		jobId,
		ownerId,
		assetId,
		objectKey,
		mimeType: "image/png",
		sourceUrl: `provider-output:${candidateKey}`,
		streamingTransfersOnly: true,
		createStagingObjectKey: (token) => `users/${ownerId}/staging/${token}.png`,
	};
	return { claim, transfer, result: { assetId, approved: false, candidateKey } };
}

function record(method: RecordMethod, seeded: Awaited<ReturnType<typeof fixture>>) {
	const store: FinalizationStore = createDatabaseFinalizationStore(client);
	return store[method]!(seeded.claim, [seeded.result]);
}

describe.each(methods)("%s job and output-binding lock order", (method) => {
	it("waits alongside the real transfer claim without holding the output binding", async () => {
		const seeded = await fixture();
		const blocker = await holdJob(seeded.claim.jobId);
		const recording = record(method, seeded);
		void recording.catch(() => undefined);
		let claiming: ReturnType<typeof claimGenerationOutputTransferTransaction> | undefined;
		try {
			await waitForBlocked(blocker.pid, 1);
			// NOWAIT proves a transaction waiting for the job has not taken its
			// binding first. Otherwise a job-first claim can deadlock with it.
			const binding = await client.$queryRaw<Array<{ position: number }>>`
				SELECT position FROM generation_job_asset
				WHERE "jobId" = ${seeded.claim.jobId} AND "assetId" = ${seeded.result.assetId}
				FOR UPDATE NOWAIT
			`;
			expect(binding).toEqual([{ position: 9 }]);
			claiming = claimGenerationOutputTransferTransaction(seeded.transfer, client);
			void claiming.catch(() => undefined);
			const blocked = await waitForBlocked(blocker.pid, 2);
			expect(blocked.every((entry) => entry.query.includes("generation_job"))).toBe(true);
			console.info(
				"finalization.lock-order",
				JSON.stringify({ method, blockedWriters: blocked.length, bindingLockAvailable: true }),
			);
			blocker.release();
			await blocker.operation;
			await expect(recording).resolves.toBeUndefined();
			await expect(claiming).resolves.toMatchObject({ outcome: "CLAIMED" });
			expect(await client.generationJobAsset.count({ where: { jobId: seeded.claim.jobId } })).toBe(
				1,
			);
			expect(
				await client.outboxEvent.count({
					where: { aggregateId: seeded.claim.jobId, eventType: "GENERATION_SETTLE" },
				}),
			).toBe(method === "recordFinalization" ? 1 : 0);
		} finally {
			blocker.release();
			await Promise.allSettled([blocker.operation, recording, ...(claiming ? [claiming] : [])]);
		}
	});

	it("rechecks a concurrently committed terminal status before binding or settlement", async () => {
		const seeded = await fixture();
		const blocker = await holdJob(seeded.claim.jobId, true);
		const recording = record(method, seeded);
		void recording.catch(() => undefined);
		try {
			await waitForBlocked(blocker.pid, 1);
			blocker.release();
			await blocker.operation;
			await expect(recording).resolves.toBeUndefined();
			expect(
				await client.generationJob.findUniqueOrThrow({ where: { id: seeded.claim.jobId } }),
			).toMatchObject({ status: "FAILED", finalizationRetryCount: 0 });
			expect(
				await client.generationJobAsset.findFirstOrThrow({
					where: { jobId: seeded.claim.jobId, assetId: seeded.result.assetId },
				}),
			).toMatchObject({ position: 9 });
			expect(await client.outboxEvent.count({ where: { aggregateId: seeded.claim.jobId } })).toBe(
				0,
			);
		} finally {
			blocker.release();
			await Promise.allSettled([blocker.operation, recording]);
		}
	});
});
