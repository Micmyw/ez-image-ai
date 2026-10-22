import { createHash } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { TestMediaSafetyAdapter } from "@repo/ai";
import {
	claimGenerationOutputTransferTransaction,
	completeGenerationOutputTransferTransaction,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../realtime/publish", () => ({
	publishCommittedMediaJobNotification: vi.fn(async () => false),
}));

import {
	createDatabaseFinalizationStore,
	createDatabaseVerifyUploadDependencies,
} from "../runtime";

let client: PrismaClient;
const checksum = "d".repeat(64);
type Claim = Parameters<typeof claimGenerationOutputTransferTransaction>[0];

beforeAll(() => {
	const connectionString = process.env.TEST_DATABASE_URL;
	if (!connectionString) throw new Error("EXPLICIT_LOCAL_TEST_DATABASE_REQUIRED");
	const url = new URL(connectionString);
	if (
		!["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
		url.port !== "55432" ||
		!/(^|[_-])(test|testing)([_-]|$)/u.test(url.pathname.slice(1)) ||
		["postgres", "template0", "template1"].includes(url.pathname.slice(1))
	)
		throw new Error("EXPLICIT_LOCAL_TEST_DATABASE_REQUIRED");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 8 }) });
});
beforeEach(() => vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());
// Real moderation evidence is append-only. Keep unique fixtures in the explicit
// isolated database, as the existing verification integration suites do.
afterAll(() => client?.$disconnect());

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((done, failed) => {
		resolve = done;
		reject = failed;
	});
	return { promise, resolve, reject };
}

async function bounded<T>(operation: Promise<T>, timeoutMs = 5_000) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("OUTPUT_REVIEW_LOCK_TIMEOUT")), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function fixture(outputCount: number) {
	const suffix = crypto.randomUUID();
	const ownerId = `review-claim-owner-${suffix}`;
	const jobId = `review-claim-job-${suffix}`;
	const quoteId = `review-claim-quote-${suffix}`;
	const attemptId = `review-claim-attempt-${suffix}`;
	await client.user.create({
		data: {
			id: ownerId,
			email: `${ownerId}@example.test`,
			emailVerified: true,
			name: "Review claim fixture",
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	await client.generationQuote.create({
		data: {
			id: quoteId,
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-nano-banana-2-lite",
			catalogVersion: "test",
			pricingVersion: "test",
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
			catalogVersion: "test",
			pricingVersion: "test",
			creditsReserved: 1n,
			inputSnapshot: {},
			pricingSnapshot: {},
			executionEngine: "legacy",
			status: "FINALIZING",
		},
	});
	await client.generationAttempt.create({
		data: {
			id: attemptId,
			jobId,
			attemptNumber: 1,
			provider: "test",
			providerModelId: "test",
			requestSnapshot: {},
			status: "SUCCEEDED",
			transferEnvelope: {
				create: {
					payload: {
						version: 1,
						outputs: Array.from({ length: outputCount }, () => ({
							kind: "remote-url",
							url: "https://provider.example/output.png",
							trust: "untrusted-transfer-candidate",
						})),
					},
				},
			},
		},
	});
	const inputs: Claim[] = [];
	for (let position = 0; position < outputCount; position++) {
		const candidateKey = `${attemptId}:${position}`;
		const assetId = `asset_${createHash("sha256").update(`${jobId}:${candidateKey}`).digest("base64url").slice(0, 32)}`;
		const objectKey = `users/${ownerId}/assets/${assetId}/original.png`;
		const sourceUrl = `provider-output:${candidateKey}`;
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId,
				kind: "OUTPUT",
				status: "VERIFYING",
				objectKey,
				mimeType: "image/png",
				byteSize: 512n,
				checksum,
				storageEtag: "stored-output",
				finalizedAt: new Date(),
				sourceUrl,
			},
		});
		await client.generationJobAsset.create({
			data: { jobId, assetId, role: "OUTPUT", position: 0, assetChecksum: checksum },
		});
		inputs.push({
			jobId,
			ownerId,
			assetId,
			objectKey,
			mimeType: "image/png",
			sourceUrl,
			streamingTransfersOnly: true,
			deferOutputReview: true,
			createStagingObjectKey: (token) => `users/${ownerId}/staging/${token}.png`,
		});
	}
	return { jobId, ownerId, attemptId, inputs };
}

function summarizeError(error: unknown) {
	if (!error || typeof error !== "object") return String(error);
	const value = error as { name?: string; code?: string; message?: string; meta?: unknown };
	return { name: value.name, code: value.code, message: value.message, meta: value.meta };
}

describe("real output review and finalization lock order", () => {
	it.each([1, 2])(
		"commits review alongside a repeated claim for %i fully transferred output(s)",
		async (outputCount) => {
			const seeded = await fixture(outputCount);
			const target = seeded.inputs.at(-1)!;
			const safety = new TestMediaSafetyAdapter("ALLOW");
			const calls = vi.spyOn(safety, "moderateImage");
			const failures: unknown[] = [];
			const ready = deferred();
			const release = deferred();
			const claimedJob = deferred();
			const reviewing = client.$extends({
				query: {
					mediaAsset: {
						async update({ args, query }) {
							const value = await query(args);
							if (args.where.id === target.assetId && args.data.status === "READY") {
								ready.resolve();
								await release.promise;
							}
							return value;
						},
					},
				},
			}) as unknown as PrismaClient;
			const verifier = createDatabaseVerifyUploadDependencies(reviewing, {
				safety,
				moderationProvider: "test",
				createSignedReadUrl: async () => "https://private.example/immutable-output",
				onVerificationError: (error) => failures.push(error),
			});
			for (const input of seeded.inputs.slice(0, -1)) await verifier.verify(input.assetId);
			const review = verifier.verify(target.assetId);
			void review.catch(ready.reject);
			const claimant = client.$extends({
				query: {
					async $executeRaw({ args, query }) {
						const value = await query(args);
						if (args.sql.includes("UPDATE") && args.sql.includes("generation_job"))
							claimedJob.resolve();
						return value;
					},
				},
			}) as unknown as PrismaClient;
			let claiming: ReturnType<typeof claimGenerationOutputTransferTransaction> | undefined;
			try {
				await bounded(ready.promise);
				claiming = claimGenerationOutputTransferTransaction(target, claimant);
				void claiming.catch(() => undefined);
				// Old ordering acquires this job while review holds the asset. New
				// ordering makes the claimant wait at the already-held job instead.
				const jobAcquiredDuringReview = await Promise.race([
					claimedJob.promise.then(() => true),
					new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
				]);
				release.resolve();
				const results = await bounded(Promise.allSettled([review, claiming]));
				const errors = results.flatMap((result) =>
					result.status === "rejected" ? [summarizeError(result.reason)] : [],
				);
				console.info(
					"output.review-claim.lock",
					JSON.stringify({
						outputCount,
						jobAcquiredDuringReview,
						errors,
						verificationErrors: failures.map(summarizeError),
					}),
				);
				expect(errors).toEqual([]);
				expect(failures).toEqual([]);
				expect(results[1]).toMatchObject({ status: "fulfilled", value: { outcome: "COMPLETED" } });
				expect(
					(await client.mediaAsset.findUniqueOrThrow({ where: { id: target.assetId } })).status,
				).toBe("READY");
				expect(calls).toHaveBeenCalledTimes(outputCount);
				expect(
					await client.outboxEvent.count({
						where: { dedupeKey: `generation-settle:${seeded.jobId}` },
					}),
				).toBe(1);
				expect(
					(
						await client.generationJobAsset.findMany({
							where: { jobId: seeded.jobId },
							orderBy: { position: "asc" },
							select: { position: true },
						})
					).map((row) => row.position),
				).toEqual(Array.from({ length: outputCount }, (_, index) => index));
			} finally {
				release.resolve();
				await Promise.allSettled([review, ...(claiming ? [claiming] : [])]);
			}
		},
	);

	it("finishes position repair alongside a stale transfer completion", async () => {
		const seeded = await fixture(2);
		const target = seeded.inputs[1]!;
		const ready = deferred();
		const release = deferred();
		const failures: unknown[] = [];
		const reviewing = client.$extends({
			query: {
				mediaAsset: {
					async update({ args, query }) {
						const value = await query(args);
						if (args.where.id === target.assetId && args.data.status === "READY") {
							ready.resolve();
							await release.promise;
						}
						return value;
					},
				},
			},
		}) as unknown as PrismaClient;
		const verifier = createDatabaseVerifyUploadDependencies(reviewing, {
			safety: new TestMediaSafetyAdapter("ALLOW"),
			moderationProvider: "test",
			createSignedReadUrl: async () => "https://private.example/immutable-output",
			onVerificationError: (error) => failures.push(error),
		});
		await verifier.verify(seeded.inputs[0]!.assetId);
		const review = verifier.verify(target.assetId);
		void review.catch(ready.reject);
		let completion: ReturnType<typeof completeGenerationOutputTransferTransaction> | undefined;
		try {
			await bounded(ready.promise);
			completion = completeGenerationOutputTransferTransaction(
				{
					assetId: target.assetId,
					ownerId: target.ownerId,
					transferToken: crypto.randomUUID(),
					bytes: 512n,
					checksum,
					storageEtag: "stored-output",
					storageVersionId: null,
				},
				client,
			);
			void completion.catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 100));
			release.resolve();
			const results = await bounded(Promise.all([review, completion]));
			expect(failures).toEqual([]);
			expect(results[1]).toMatchObject({ outcome: "STALE" });
			expect(
				await client.outboxEvent.count({
					where: { dedupeKey: `generation-settle:${seeded.jobId}` },
				}),
			).toBe(1);
			expect(
				(
					await client.generationJobAsset.findMany({
						where: { jobId: seeded.jobId },
						orderBy: { position: "asc" },
						select: { position: true },
					})
				).map((row) => row.position),
			).toEqual([0, 1]);
		} finally {
			release.resolve();
			await Promise.allSettled([review, ...(completion ? [completion] : [])]);
		}
	});

	it("repairs a second output position while a duplicate finalization record waits on its job", async () => {
		const seeded = await fixture(2);
		const target = seeded.inputs[1]!;
		const ready = deferred();
		const release = deferred();
		const failures: unknown[] = [];
		const reviewing = client.$extends({
			query: {
				generationJobAsset: {
					async updateMany({ args, query }) {
						const value = await query(args);
						if (args.where?.assetId === target.assetId && args.data.position === 1) {
							ready.resolve();
							await release.promise;
						}
						return value;
					},
				},
			},
		}) as unknown as PrismaClient;
		const verifier = createDatabaseVerifyUploadDependencies(reviewing, {
			safety: new TestMediaSafetyAdapter("ALLOW"),
			moderationProvider: "test",
			createSignedReadUrl: async () => "https://private.example/immutable-output",
			onVerificationError: (error) => failures.push(error),
		});
		await verifier.verify(seeded.inputs[0]!.assetId);
		const review = verifier.verify(target.assetId);
		void review.catch(ready.reject);
		let recording: Promise<void> | undefined;
		try {
			await bounded(ready.promise);
			const candidateKey = `${seeded.attemptId}:1`;
			recording = createDatabaseFinalizationStore(client).recordFinalizationWait!(
				{
					jobId: seeded.jobId,
					ownerId: seeded.ownerId,
					mediaKind: "image",
					candidates: seeded.inputs.map((_input, position) => ({
						key: `${seeded.attemptId}:${position}`,
						output: {
							kind: "remote-url" as const,
							url: "https://provider.example/output.png",
							trust: "untrusted-transfer-candidate" as const,
						},
					})),
				},
				[{ assetId: target.assetId, approved: true, candidateKey }],
			);
			void recording.catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 100));
			release.resolve();
			const results = await bounded(Promise.allSettled([review, recording]));
			const errors = results.flatMap((result) =>
				result.status === "rejected" ? [summarizeError(result.reason)] : [],
			);
			console.info(
				"output.review-record.lock",
				JSON.stringify({ errors, verificationErrors: failures.map(summarizeError) }),
			);
			expect(errors).toEqual([]);
			expect(failures).toEqual([]);
			expect(
				await client.outboxEvent.count({
					where: { dedupeKey: `generation-settle:${seeded.jobId}` },
				}),
			).toBe(1);
		} finally {
			release.resolve();
			await Promise.allSettled([review, ...(recording ? [recording] : [])]);
		}
	});
});
