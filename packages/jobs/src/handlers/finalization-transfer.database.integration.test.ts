import { PrismaPg } from "@prisma/adapter-pg";
import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	TestMediaSafetyAdapter,
	createRouteGraphSnapshot,
	type ProviderOutput,
} from "@repo/ai";
import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import {
	claimGenerationOutputTransferTransaction,
	completeGenerationOutputTransferTransaction,
	createCreditGrant,
	createGenerationJobTransaction,
	createModeratedGenerationQuoteTransaction,
	failGenerationOutputTransferTransaction,
	fingerprintGenerationQuoteSecurityPayload,
	reserveGenerationOutputStorageTransaction,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import {
	GUEST_WATERMARK_VERSION,
	GuestWatermarkError,
	MediaValidationError,
	promoteStagedObject,
	putPrivateMediaObject,
	RemoteMediaPolicyError,
	streamRemoteObjectToStorage,
	watermarkStagedGuestImage,
} from "@repo/storage";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const globalStorage = vi.hoisted(() => ({
	// Existing cases exercise legacy streaming/promotion and guest recovery.
	tryWriteImmutableGenerationImage: vi.fn(async () => null),
	inspectRemoteMedia: vi.fn(async () => ({ contentType: "image/png" as const })),
	putPrivateMediaObject: vi.fn(async () => {
		throw new Error("GLOBAL_STORAGE_USED");
	}),
	streamRemoteObjectToStorage: vi.fn(async () => {
		throw new Error("GLOBAL_STORAGE_USED");
	}),
	promoteStagedObject: vi.fn(async () => {
		throw new Error("GLOBAL_STORAGE_USED");
	}),
	watermarkStagedGuestImage: vi.fn(async () => {
		throw new Error("GLOBAL_STORAGE_USED");
	}),
}));

vi.mock("@repo/storage", async () => ({
	...(await vi.importActual<typeof import("@repo/storage")>("@repo/storage")),
	...globalStorage,
}));

import {
	createDatabaseDispatchStore,
	createDatabaseFinalizationStore,
	createDatabaseSettlementStore,
	createDatabaseVerifyUploadDependencies,
	createFinalizationDependencies,
} from "../runtime";
import { finalizeMedia } from "./finalize-media";
import { settleGeneration } from "./settle-generation";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const PNG_BODY = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");
const PNG_CHECKSUM = "d".repeat(64);
let client: PrismaClient;

describe("generation output transfer runtime", () => {
	beforeAll(() => {
		assertSafeTestDatabaseUrl(TEST_DATABASE_URL);
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }),
		});
	});

	afterAll(async () => client?.$disconnect());
	it
		.skipIf(process.env.RUN_MEDIA_STORAGE_INTEGRATION !== "true")
		.each(["DB_FAILURE", "LEASE_EXPIRED"])(
		"recovers a real immutable S3 output after %s without retransfer or generation",
		async (failure) => {
			const endpoint = new URL(process.env.S3_ENDPOINT ?? "");
			if (endpoint.hostname !== "127.0.0.1" || endpoint.port !== "9540")
				throw new Error("USE_ISOLATED_MINIO");
			const storage = await vi.importActual<typeof import("@repo/storage")>("@repo/storage");
			const seeded = await seedFinalizingJob([
				{
					kind: "inline-base64",
					mimeType: "image/png",
					data: PNG_BODY.toString("base64"),
					trust: "untrusted-transfer-candidate",
				},
			]);
			const claim = await createDatabaseFinalizationStore(client).claimFinalization({
				jobId: seeded.jobId,
				version: seeded.version,
			});
			if (!claim) throw new Error("Expected claim");
			const verification = createDatabaseVerifyUploadDependencies(client, {
				safety: new TestMediaSafetyAdapter("ALLOW"),
				moderationProvider: "test",
			});
			let inject = true;
			let target: { bucket: "media"; key: string } | undefined;
			const direct: typeof storage.tryWriteImmutableGenerationImage = async (input) => {
				target = { bucket: "media", key: input.key };
				const written = await storage.tryWriteImmutableGenerationImage(input);
				if (inject) {
					inject = false;
					if (failure === "DB_FAILURE") throw new Error("DB_COMMIT_UNAVAILABLE");
					await client.mediaAsset.updateMany({
						where: { objectKey: input.key },
						data: { outputTransferLeaseExpiresAt: new Date(0) },
					});
				}
				return written;
			};
			const deps = createFinalizationDependencies(process.env, {
				database: client,
				verification,
				storage: { tryWriteImmutableGenerationImage: direct },
			});
			try {
				await expect(deps.persistCandidate(claim, claim.candidates[0]!)).rejects.toMatchObject({
					retryable: true,
				});
				const placeholder = await client.mediaAsset.findFirstOrThrow({
					where: { ownerId: seeded.ownerId, kind: "OUTPUT" },
				});
				expect(placeholder.status).not.toBe("READY");
				const before = await storage.headObject(target!);
				await client.mediaAsset.update({
					where: { id: placeholder.id },
					data: { outputTransferLeaseExpiresAt: new Date(0) },
				});
				await expect(deps.persistCandidate(claim, claim.candidates[0]!)).resolves.toMatchObject({
					approved: true,
					assetId: placeholder.id,
				});
				const asset = await client.mediaAsset.findUniqueOrThrow({ where: { id: placeholder.id } });
				expect(asset.status).toBe("READY");
				expect(asset.storageEtag).toBe(before.etag);
				expect((await storage.headObject(target!)).etag).toBe(before.etag);
				expect(await client.generationAttempt.count({ where: { jobId: seeded.jobId } })).toBe(1);
				expect(
					await client.assetModerationResult.count({
						where: { assetId: asset.id, status: "APPROVED" },
					}),
				).toBe(1);
				const reservation = await client.creditReservation.findUniqueOrThrow({
					where: { jobId: seeded.jobId },
				});
				expect(reservation).toMatchObject({ status: "ACTIVE", settledAmount: 0n });
				const cleanup = await client.outboxEvent.findMany({
					where: { aggregateId: asset.id, eventType: "MEDIA_OBJECT_DELETE" },
				});
				for (const event of cleanup)
					expect(JSON.stringify(event.payload)).not.toContain(target!.key);
			} finally {
				if (target) await storage.deleteObject(target);
			}
		},
	);
	it("keeps a fixed-time output PENDING durable without technical retries, duplicate inference or credits", async () => {
		const seeded = await seedFinalizingJob([
			{
				kind: "remote-url",
				url: "https://replicate.delivery/pending.png",
				trust: "untrusted-transfer-candidate",
			},
		]);
		const started = Date.now();
		const completeAt = started + 7_500;
		const submit = vi.fn(async (input: { idempotencyKey: string; ruleVersion: string }) => ({
			moderationTaskId: "persisted-seeapi-task",
			status: "QUEUED" as const,
			ruleVersion: input.ruleVersion,
			idempotency: { key: input.idempotencyKey, providerSupported: false, replayed: false },
		}));
		let duringRetrieval: (() => Promise<void>) | undefined;
		const retrieve = vi.fn(async (input: { ruleVersion: string }) => {
			await duringRetrieval?.();
			return {
				decision: Date.now() < completeAt ? ("REVIEW" as const) : ("ALLOW" as const),
				reasonCode: Date.now() < completeAt ? "IMAGE_PROCESSING" : "TEST_ALLOW",
				ruleVersion: input.ruleVersion,
			};
		});
		const safety = Object.assign(new TestMediaSafetyAdapter("ERROR"), {
			submitImage: submit,
			retrieveImage: retrieve,
		});
		const verification = createDatabaseVerifyUploadDependencies(client, {
			safety,
			moderationProvider: "test",
			createSignedReadUrl: async () => "https://private.example/output",
		});
		const stream = vi.fn(async () => ({ bytes: PNG_BODY.byteLength, sha256: PNG_CHECKSUM }));
		const dependencies = createFinalizationDependencies(process.env, {
			database: client,
			verification,
			safety,
			storage: {
				streamRemoteObjectToStorage: stream,
				promoteStagedObject: async () => ({
					bytes: PNG_BODY.byteLength,
					sha256: PNG_CHECKSUM,
					etag: "etag",
					versionId: null,
				}),
			},
		});
		const payload = { jobId: seeded.jobId, version: seeded.version };
		const ledgerBefore = await client.creditLedgerEntry.findMany({
			where: { account: { ownerId: seeded.ownerId } },
			orderBy: { id: "asc" },
		});
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(started);
		try {
			const result = await finalizeMedia(payload, dependencies);
			expect(result).toMatchObject({ outcome: "WAITING_MODERATION", readyOutputs: 0 });
			expect(result.outputReviewEventIds).toHaveLength(1);
			const event = await client.outboxEvent.findUniqueOrThrow({
				where: { id: result.outputReviewEventIds![0] },
			});
			const assetId = event.aggregateId;
			expect(event).toMatchObject({
				eventType: "MEDIA_ASSET_VERIFY",
				status: "PENDING",
				availableAt: new Date(started),
				attempts: 0,
				payload: { assetId },
			});
			expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).toMatchObject({
				verificationProviderTaskId: "persisted-seeapi-task",
				verificationNextAttemptAt: new Date(started + 5000),
				verificationLeaseToken: null,
				outputTransferToken: null,
				status: "VERIFYING",
			});
			// Simulate losing the committed finalizer response / crashing before wake.
			// A duplicate finalizer returns the same stored event without resetting time.
			vi.setSystemTime(started + 4000);
			expect(await finalizeMedia(payload, dependencies)).toEqual(result);
			expect(retrieve).toHaveBeenCalledTimes(1);
			vi.setSystemTime(started + 5000);
			let release!: () => void;
			let reached!: () => void;
			const atProvider = new Promise<void>((resolve) => {
				reached = resolve;
			});
			const response = new Promise<void>((resolve) => {
				release = resolve;
			});
			duringRetrieval = async () => {
				reached();
				await response;
			};
			const activePoll = verification.verify(assetId);
			await atProvider;
			try {
				// A scanner may already be querying the same persisted task when a
				// duplicate finalizer resumes. Its live lease is a wait, not a failure.
				expect(await finalizeMedia(payload, dependencies)).toEqual(result);
			} finally {
				release();
				await activePoll;
				duringRetrieval = undefined;
			}
			expect(retrieve).toHaveBeenCalledTimes(2);
			expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).toMatchObject({
				status: "VERIFYING",
				verificationNextAttemptAt: new Date(started + 10000),
			});
			expect(
				await client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
			).toMatchObject({
				status: "FINALIZING",
				finalizationRetryCount: 0,
				finalizationErrorCode: null,
			});
			expect(
				await client.creditLedgerEntry.findMany({
					where: { account: { ownerId: seeded.ownerId } },
					orderBy: { id: "asc" },
				}),
			).toEqual(ledgerBefore);
			vi.setSystemTime(started + 10000);
			await Promise.all([verification.verify(assetId), verification.verify(assetId)]);
			expect(retrieve).toHaveBeenCalledTimes(3);
			expect(submit).toHaveBeenCalledTimes(1);
			expect(stream).toHaveBeenCalledTimes(1);
			expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).toMatchObject({
				status: "READY",
				verificationProviderTaskId: "persisted-seeapi-task",
				verificationLeaseToken: null,
			});
			expect(
				await client.assetModerationResult.findMany({
					where: { assetId },
					orderBy: { attemptNumber: "asc" },
					select: { status: true },
				}),
			).toEqual([{ status: "PENDING" }, { status: "PENDING" }, { status: "APPROVED" }]);
			await finalizeMedia(payload, dependencies);
			await settleGeneration(payload, { store: createDatabaseSettlementStore(client) });
			await settleGeneration(payload, { store: createDatabaseSettlementStore(client) });
			expect(await client.generationAttempt.count({ where: { jobId: seeded.jobId } })).toBe(1);
			expect(
				await client.creditLedgerEntry.count({ where: { referenceKey: `settle:${seeded.jobId}` } }),
			).toBe(1);
			expect(
				await client.creditReservation.findUniqueOrThrow({ where: { jobId: seeded.jobId } }),
			).toMatchObject({ status: "SETTLED" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("lets one actor write staging and fences a concurrent duplicate before storage", async () => {
		const seeded = await seedFinalizingJob([
			{
				kind: "remote-url",
				url: "https://replicate.delivery/output.png",
				trust: "untrusted-transfer-candidate",
			},
		]);
		const claim = await createDatabaseFinalizationStore(client).claimFinalization({
			jobId: seeded.jobId,
			version: seeded.version,
		});
		if (!claim) throw new Error("Expected finalization claim");
		let releaseStorage!: () => void;
		let storageReached!: () => void;
		const reached = new Promise<void>((resolve) => {
			storageReached = resolve;
		});
		const released = new Promise<void>((resolve) => {
			releaseStorage = resolve;
		});
		const stream = vi.fn(async (_input: Parameters<typeof streamRemoteObjectToStorage>[0]) => {
			storageReached();
			await released;
			return { bytes: PNG_BODY.byteLength, sha256: PNG_CHECKSUM };
		});
		const put = vi.fn(async (_input: Parameters<typeof putPrivateMediaObject>[0]) => ({
			bytes: PNG_BODY.byteLength,
			sha256: PNG_CHECKSUM,
		}));
		const promote = vi.fn(async (input: Parameters<typeof promoteStagedObject>[0]) => {
			await input.promotion?.onMultipartUploadCreated?.({ uploadId: "promotion-runtime-1" });
			return {
				bytes: PNG_BODY.byteLength,
				sha256: PNG_CHECKSUM,
				etag: '"runtime-final-etag"',
				versionId: "runtime-final-version",
			};
		});
		const productionVerification = createDatabaseVerifyUploadDependencies(client, {
			headObject: async () => ({
				contentLength: PNG_BODY.byteLength,
				contentType: "image/png",
				etag: '"runtime-final-etag"',
				metadata: {},
			}),
			readMediaHeader: async () => PNG_BODY,
			inspectPrivateMediaObject: async () => ({
				bytes: PNG_BODY.byteLength,
				sha256: PNG_CHECKSUM,
				etag: '"runtime-final-etag"',
				versionId: "runtime-final-version",
			}),
			createSignedReadUrl: async () => "https://private.example/runtime-output.png",
			safety: new TestMediaSafetyAdapter("ALLOW"),
			moderationProvider: "test",
		});
		const verify = vi.fn((assetId: string) => productionVerification.verify(assetId));
		const dependencies = createFinalizationDependencies(process.env, {
			database: client,
			verification: { verify },
			storage: {
				putPrivateMediaObject: put,
				streamRemoteObjectToStorage: stream,
				promoteStagedObject: promote,
			},
		});

		const first = dependencies.persistCandidate(claim, claim.candidates[0]!);
		await expect(
			Promise.race([
				reached.then(() => "reached" as const),
				first.then(
					() => "finished" as const,
					() => "failed" as const,
				),
			]),
		).resolves.toBe("reached");
		await expect(dependencies.persistCandidate(claim, claim.candidates[0]!)).rejects.toMatchObject({
			code: "OUTPUT_TRANSFER_IN_PROGRESS",
			stage: "TRANSFER",
			retryable: true,
		});
		expect(stream).toHaveBeenCalledTimes(1);
		expect(put).not.toHaveBeenCalled();
		expect(promote).not.toHaveBeenCalled();

		releaseStorage();
		await expect(first).resolves.toMatchObject({ approved: true });
		expect(stream).toHaveBeenCalledTimes(1);
		expect(promote).toHaveBeenCalledTimes(1);
		expect(verify).toHaveBeenCalledTimes(1);
		const binding = await client.generationJobAsset.findFirstOrThrow({
			where: { jobId: seeded.jobId, role: "OUTPUT" },
			include: { asset: true },
		});
		expect(binding.assetId).toMatch(/^asset_[A-Za-z0-9_-]{32}$/u);
		expect(binding.assetChecksum).toBe(PNG_CHECKSUM);
		expect(binding.asset).toMatchObject({
			status: "READY",
			checksum: PNG_CHECKSUM,
			storageEtag: '"runtime-final-etag"',
			storageVersionId: "runtime-final-version",
			outputTransferToken: null,
			outputTransferLeaseExpiresAt: null,
			outputStagingObjectKey: null,
			outputPromotionMultipartUploadId: null,
		});
	});

	it("terminalizes a claimed output when deterministic remote validation fails", async () => {
		const seeded = await seedFinalizingJob([
			{
				kind: "remote-url",
				url: "https://replicate.delivery/not-an-image.png",
				trust: "untrusted-transfer-candidate",
			},
		]);
		const claim = await createDatabaseFinalizationStore(client).claimFinalization({
			jobId: seeded.jobId,
			version: seeded.version,
		});
		if (!claim) throw new Error("Expected finalization claim");
		const validationError = new MediaValidationError(
			"OUTPUT_MEDIA_TYPE_MISMATCH",
			"Provider bytes do not match image/png",
		);
		const stream = vi.fn(async (_input: Parameters<typeof streamRemoteObjectToStorage>[0]) => {
			throw validationError;
		});
		const promote = vi.fn(async (_input: Parameters<typeof promoteStagedObject>[0]) =>
			Promise.reject(new Error("promotion must not run")),
		);
		const verify = vi.fn(async (_assetId: string) => undefined);
		const dependencies = createFinalizationDependencies(process.env, {
			database: client,
			verification: { verify },
			storage: { streamRemoteObjectToStorage: stream, promoteStagedObject: promote },
		});

		await expect(dependencies.persistCandidate(claim, claim.candidates[0]!)).rejects.toBe(
			validationError,
		);
		expect(promote).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
		const binding = await client.generationJobAsset.findFirstOrThrow({
			where: { jobId: seeded.jobId, role: "OUTPUT" },
			include: { asset: true },
		});
		expect(binding.assetChecksum).toBe(`pending-output:${binding.assetId}`);
		expect(binding.asset).toMatchObject({
			status: "VERIFICATION_FAILED",
			verificationLastErrorCode: "OUTPUT_MEDIA_TYPE_MISMATCH",
			verificationExhaustedAt: expect.any(Date),
			outputTransferToken: null,
			outputTransferLeaseExpiresAt: null,
			outputStagingObjectKey: null,
			outputPromotionMultipartUploadId: null,
		});
	});

	it("does not publish a guest output when clean staging cannot be physically deleted", async () => {
		const seeded = await seedFinalizingJob([
			{
				kind: "remote-url",
				url: "https://replicate.delivery/guest-output.png",
				trust: "untrusted-transfer-candidate",
			},
		]);
		const deleteAfter = new Date(Date.now() + 24 * 60 * 60_000);
		await markSeededJobAsGuest(seeded, deleteAfter);
		const claim = await createDatabaseFinalizationStore(client).claimFinalization({
			jobId: seeded.jobId,
			version: seeded.version,
		});
		if (!claim) throw new Error("Expected guest finalization claim");

		const promote = vi.fn(async (_input: Parameters<typeof promoteStagedObject>[0]) => ({
			bytes: PNG_BODY.byteLength,
			sha256: PNG_CHECKSUM,
			etag: null,
			versionId: null,
		}));
		const watermark = vi.fn(async (_input: Parameters<typeof watermarkStagedGuestImage>[0]) => {
			throw new GuestWatermarkError("GUEST_CLEAN_STAGE_DELETE_REQUIRED");
		});
		const verify = vi.fn(async () => undefined);
		const dependencies = createFinalizationDependencies(process.env, {
			database: client,
			verification: { verify },
			storage: {
				streamRemoteObjectToStorage: vi.fn(async () => ({
					bytes: PNG_BODY.byteLength,
					sha256: PNG_CHECKSUM,
				})),
				promoteStagedObject: promote,
				watermarkStagedGuestImage: watermark,
			} as never,
		});

		await expect(dependencies.persistCandidate(claim, claim.candidates[0]!)).rejects.toMatchObject({
			code: "GUEST_CLEAN_STAGE_DELETE_REQUIRED",
			stage: "TRANSFER",
			retryable: false,
		});
		expect(watermark).toHaveBeenCalledWith(expect.objectContaining({ deleteAfter }));
		expect(promote).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
		const output = await client.mediaAsset.findFirstOrThrow({
			where: { sourceUrl: `provider-output:${claim.candidates[0]!.key}` },
		});
		expect(output).toMatchObject({
			status: "VERIFICATION_FAILED",
			retentionClass: "GUEST_TRIAL",
			deleteAfter,
			watermarkVersion: null,
			watermarkedAt: null,
			cleanStagingDeletedAt: null,
		});
		await client.generationJob.update({
			where: { id: seeded.jobId },
			data: { status: "FAILED", terminalAt: new Date() },
		});
	});

	it("refuses guest output completion after the absolute retention deadline", async () => {
		const seeded = await seedFinalizingJob([
			{
				kind: "remote-url",
				url: "https://replicate.delivery/guest-expired-output.png",
				trust: "untrusted-transfer-candidate",
			},
		]);
		const startedAt = new Date("2026-08-28T00:00:00.000Z");
		const deleteAfter = new Date(startedAt.getTime() + 60_000);
		await markSeededJobAsGuest(seeded, deleteAfter);
		const assetId = `asset_guest_expiry_${crypto.randomUUID().replaceAll("-", "")}`;
		try {
			const claimed = await claimGenerationOutputTransferTransaction(
				{
					jobId: seeded.jobId,
					ownerId: seeded.ownerId,
					assetId,
					objectKey: `users/${seeded.ownerId}/assets/${assetId}/original.png`,
					mimeType: "image/png",
					sourceUrl: `provider-output:${assetId}`,
					guest: { deleteAfter },
					createStagingObjectKey: (token) =>
						`users/${seeded.ownerId}/staging/${assetId}/${token}.png`,
					now: startedAt,
				},
				client,
			);
			if (claimed.outcome !== "CLAIMED") throw new Error("Expected guest transfer claim");
			await expect(
				reserveGenerationOutputStorageTransaction(
					{
						assetId,
						ownerId: seeded.ownerId,
						transferToken: claimed.transferToken,
						bytes: BigInt(PNG_BODY.byteLength),
						maximumStorageBytes: 1_000n,
						now: new Date(startedAt.getTime() + 10_000),
					},
					client,
				),
			).resolves.toMatchObject({ outcome: "RESERVED" });

			await expect(
				completeGenerationOutputTransferTransaction(
					{
						assetId,
						ownerId: seeded.ownerId,
						transferToken: claimed.transferToken,
						bytes: BigInt(PNG_BODY.byteLength),
						checksum: "f".repeat(64),
						storageEtag: '"guest-expired-etag"',
						storageVersionId: "guest-expired-version",
						guestWatermark: {
							version: GUEST_WATERMARK_VERSION,
							watermarkedAt: new Date(startedAt.getTime() + 20_000),
							cleanStagingDeletedAt: new Date(startedAt.getTime() + 30_000),
							deleteAfter,
						},
						now: new Date(deleteAfter.getTime() + 1),
					},
					client,
				),
			).rejects.toThrow("GENERATION_OUTPUT_GUEST_RETENTION_EXPIRED");
		} finally {
			await client.generationJob.update({
				where: { id: seeded.jobId },
				data: { status: "FAILED", terminalAt: new Date() },
			});
		}
	});

	it("moderates and publishes the transformed guest output despite storage host clock skew", async () => {
		const seeded = await seedFinalizingJob([
			{
				kind: "remote-url",
				url: "https://replicate.delivery/guest-watermarked-output.png",
				trust: "untrusted-transfer-candidate",
			},
		]);
		const deleteAfter = new Date(Date.now() + 24 * 60 * 60_000);
		await markSeededJobAsGuest(seeded, deleteAfter);
		const claim = await createDatabaseFinalizationStore(client).claimFinalization({
			jobId: seeded.jobId,
			version: seeded.version,
		});
		if (!claim) throw new Error("Expected guest finalization claim");

		const transformedChecksum = "e".repeat(64);
		// A successful storage operation may be timed by a host ahead of PostgreSQL.
		// Persist its observed completion on the database clock without rejecting it.
		const [databaseClock] = await client.$queryRaw<Array<{ now: Date }>>`
			SELECT clock_timestamp() AS "now"`;
		if (!databaseClock) throw new Error("Expected the database clock");
		const cleanStagingDeletedAt = new Date(databaseClock.now.getTime() + 60_000);
		const promote = vi.fn(async (_input: Parameters<typeof promoteStagedObject>[0]) => ({
			bytes: PNG_BODY.byteLength,
			sha256: PNG_CHECKSUM,
			etag: null,
			versionId: null,
		}));
		const watermark = vi.fn(async (_input: Parameters<typeof watermarkStagedGuestImage>[0]) => ({
			bytes: PNG_BODY.byteLength,
			sha256: transformedChecksum,
			etag: '"guest-watermarked-etag"',
			versionId: "guest-watermarked-version",
			cleanStagingDeletedAt,
		}));
		const verification = createDatabaseVerifyUploadDependencies(client, {
			headObject: async () => ({
				contentLength: PNG_BODY.byteLength,
				contentType: "image/png",
				etag: '"guest-watermarked-etag"',
				metadata: {},
			}),
			readMediaHeader: async () => PNG_BODY,
			createSignedReadUrl: async () => "https://private.example/guest-watermarked-output.png",
			safety: new TestMediaSafetyAdapter("ALLOW"),
			moderationProvider: "test",
		});
		const dependencies = createFinalizationDependencies(process.env, {
			database: client,
			verification,
			storage: {
				streamRemoteObjectToStorage: vi.fn(async () => ({
					bytes: PNG_BODY.byteLength,
					sha256: PNG_CHECKSUM,
				})),
				promoteStagedObject: promote,
				watermarkStagedGuestImage: watermark,
			},
		});

		await expect(dependencies.persistCandidate(claim, claim.candidates[0]!)).resolves.toMatchObject(
			{ approved: true },
		);
		expect(watermark).toHaveBeenCalledWith(expect.objectContaining({ deleteAfter }));
		expect(promote).not.toHaveBeenCalled();
		const output = await client.mediaAsset.findFirstOrThrow({
			where: { sourceUrl: `provider-output:${claim.candidates[0]!.key}` },
		});
		expect(output).toMatchObject({
			status: "READY",
			checksum: transformedChecksum,
			retentionClass: "GUEST_TRIAL",
			deleteAfter,
			watermarkVersion: GUEST_WATERMARK_VERSION,
		});
		const [completedClock] = await client.$queryRaw<Array<{ now: Date }>>`
			SELECT clock_timestamp() AS "now"`;
		expect(output.watermarkedAt).toEqual(output.cleanStagingDeletedAt);
		expect(output.cleanStagingDeletedAt?.getTime()).toBeGreaterThanOrEqual(
			databaseClock.now.getTime(),
		);
		expect(output.cleanStagingDeletedAt?.getTime()).toBeLessThanOrEqual(
			completedClock!.now.getTime(),
		);
		expect(output.cleanStagingDeletedAt).not.toEqual(cleanStagingDeletedAt);
		await client.generationJob.update({
			where: { id: seeded.jobId },
			data: { status: "FAILED", terminalAt: new Date() },
		});
	});

	it("terminalizes a deterministic remote URL policy rejection without promotion", async () => {
		const seeded = await seedFinalizingJob([
			{
				kind: "remote-url",
				url: "https://untrusted.example/output.png",
				trust: "untrusted-transfer-candidate",
			},
		]);
		const claim = await createDatabaseFinalizationStore(client).claimFinalization({
			jobId: seeded.jobId,
			version: seeded.version,
		});
		if (!claim) throw new Error("Expected finalization claim");
		const policyError = new RemoteMediaPolicyError(
			"OUTPUT_REMOTE_URL_HOST_NOT_ALLOWED",
			"Remote URL host is not allowed",
		);
		const stream = vi.fn(async (_input: Parameters<typeof streamRemoteObjectToStorage>[0]) => {
			throw policyError;
		});
		const promote = vi.fn(async (_input: Parameters<typeof promoteStagedObject>[0]) =>
			Promise.reject(new Error("promotion must not run")),
		);
		const dependencies = createFinalizationDependencies(process.env, {
			database: client,
			verification: { verify: vi.fn(async () => undefined) },
			storage: { streamRemoteObjectToStorage: stream, promoteStagedObject: promote },
		});

		await expect(dependencies.persistCandidate(claim, claim.candidates[0]!)).rejects.toBe(
			policyError,
		);
		expect(promote).not.toHaveBeenCalled();
		const binding = await client.generationJobAsset.findFirstOrThrow({
			where: { jobId: seeded.jobId, role: "OUTPUT" },
			include: { asset: true },
		});
		expect(binding.asset).toMatchObject({
			status: "VERIFICATION_FAILED",
			verificationLastErrorCode: "OUTPUT_REMOTE_URL_HOST_NOT_ALLOWED",
			outputTransferToken: null,
		});
	});

	it("rejects aggregate output quota before promotion and queues fenced physical cleanup", async () => {
		const seeded = await seedFinalizingJob([
			{
				kind: "remote-url",
				url: "https://replicate.delivery/quota.png",
				trust: "untrusted-transfer-candidate",
			},
		]);
		await client.storageUsageReservation.create({
			data: {
				ownerType: "USER",
				ownerId: seeded.ownerId,
				bytes: 90n,
				status: "COMMITTED",
				referenceKey: `quota-existing:${crypto.randomUUID()}`,
				expiresAt: new Date(),
			},
		});
		const claim = await createDatabaseFinalizationStore(client).claimFinalization({
			jobId: seeded.jobId,
			version: seeded.version,
		});
		if (!claim) throw new Error("Expected finalization claim");
		const stream = vi.fn(async (_input: Parameters<typeof streamRemoteObjectToStorage>[0]) => ({
			bytes: PNG_BODY.byteLength,
			sha256: PNG_CHECKSUM,
		}));
		const promote = vi.fn(async (_input: Parameters<typeof promoteStagedObject>[0]) => ({
			bytes: PNG_BODY.byteLength,
			sha256: PNG_CHECKSUM,
			etag: '"quota-etag"',
			versionId: "quota-version",
		}));
		const dependencies = createFinalizationDependencies(
			{ ...process.env, MEDIA_MAX_STORAGE_BYTES: "100" },
			{
				database: client,
				verification: { verify: vi.fn(async () => undefined) },
				storage: { streamRemoteObjectToStorage: stream, promoteStagedObject: promote },
			},
		);

		await expect(dependencies.persistCandidate(claim, claim.candidates[0]!)).rejects.toMatchObject({
			code: "STORAGE_QUOTA_EXCEEDED",
			stage: "TRANSFER",
			retryable: false,
		});
		expect(stream).toHaveBeenCalledOnce();
		expect(promote).not.toHaveBeenCalled();
		const binding = await client.generationJobAsset.findFirstOrThrow({
			where: { jobId: seeded.jobId, role: "OUTPUT" },
			include: { asset: true },
		});
		expect(binding.asset).toMatchObject({
			status: "VERIFICATION_FAILED",
			verificationLastErrorCode: "STORAGE_QUOTA_EXCEEDED",
			outputTransferToken: null,
		});
		await expect(
			client.storageUsageReservation.findUnique({
				where: { referenceKey: `generation-output:${binding.assetId}` },
			}),
		).resolves.toBeNull();
		await expect(
			client.outboxEvent.findFirst({
				where: {
					aggregateId: binding.assetId,
					eventType: "MEDIA_OBJECT_DELETE",
				},
			}),
		).resolves.toMatchObject({
			payload: expect.objectContaining({
				objectKey: binding.asset.objectKey,
				storageReservationReferenceKey: `generation-output:${binding.assetId}`,
			}),
		});
	});

	it("records a checksumless rejected output and queues settlement after the full scan", async () => {
		const seeded = await seedFinalizingJob([
			{
				kind: "remote-url",
				url: "https://replicate.delivery/rejected.png",
				trust: "untrusted-transfer-candidate",
			},
		]);
		const store = createDatabaseFinalizationStore(client);
		const claim = await store.claimFinalization({ jobId: seeded.jobId, version: seeded.version });
		if (!claim) throw new Error("Expected finalization claim");
		const assetId = `asset_${crypto.randomUUID().replaceAll("-", "").slice(0, 32)}`;
		const objectKey = `users/${claim.ownerId}/assets/${assetId}/original.png`;
		const transfer = await claimGenerationOutputTransferTransaction(
			{
				jobId: claim.jobId,
				ownerId: claim.ownerId,
				assetId,
				objectKey,
				mimeType: "image/png",
				sourceUrl: `provider-output:${claim.candidates[0]!.key}`,
				createStagingObjectKey: (token) => `users/${claim.ownerId}/staging/${assetId}/${token}.png`,
			},
			client,
		);
		if (transfer.outcome !== "CLAIMED") throw new Error("Expected output transfer claim");
		await failGenerationOutputTransferTransaction(
			{
				assetId,
				ownerId: claim.ownerId,
				transferToken: transfer.transferToken,
				errorCode: "OUTPUT_MEDIA_TYPE_MISMATCH",
			},
			client,
		);

		await expect(
			store.recordFinalization(
				claim,
				[
					{
						assetId,
						approved: false,
						candidateKey: claim.candidates[0]!.key,
					},
				],
				{ stage: "TRANSFER", code: "OUTPUT_MEDIA_TYPE_MISMATCH", retryable: false },
			),
		).resolves.toBeUndefined();
		await expect(
			client.generationJobAsset.findUniqueOrThrow({
				where: { jobId_assetId_role: { jobId: claim.jobId, assetId, role: "OUTPUT" } },
			}),
		).resolves.toMatchObject({ assetChecksum: `pending-output:${assetId}` });
		await expect(
			client.outboxEvent.count({
				where: {
					aggregateId: claim.jobId,
					eventType: "GENERATION_SETTLE",
					dedupeKey: `generation-settle:${claim.jobId}`,
				},
			}),
		).resolves.toBe(1);
	});
});

async function seedFinalizingJob(outputs: ProviderOutput[]) {
	const suffix = crypto.randomUUID();
	const ownerId = `output-transfer-runtime-${suffix}`;
	const checksum = "a".repeat(64);
	const verificationValidUntil = new Date(Date.now() + 60_000);
	const inputAsset = await client.mediaAsset.create({
		data: {
			id: `asset_${suffix}`,
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			objectKey: `users/${ownerId}/assets/${suffix}/original.png`,
			mimeType: "image/png",
			byteSize: 16n,
			checksum,
			finalizedAt: new Date(),
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			verificationValidUntil,
		},
	});
	await client.assetModerationResult.create({
		data: {
			assetId: inputAsset.id,
			assetChecksum: checksum,
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "INPUT",
			provider: "test",
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			status: "APPROVED",
			reasonCode: "TEST_ALLOW",
			categories: {},
			rawEnvelope: { decision: "ALLOW" },
			validUntil: verificationValidUntil,
		},
	});
	await client.mediaAsset.update({ where: { id: inputAsset.id }, data: { status: "READY" } });
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{ accountId: account.id, amount: 100n, referenceKey: `output-transfer-grant:${suffix}` },
		client,
	);
	const quoteInput = {
		ownerType: "USER",
		ownerId,
		submittedByUserId: ownerId,
		productKey: "image-nano-banana-2-lite",
		catalogVersion: DEFAULT_PRODUCT_CONFIG.catalogVersion,
		pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
		credits: 5n,
		costMicros: 20_000n,
		inputSnapshot: {
			kind: "image-to-image",
			prompt: "output transfer test",
			sourceAssetId: inputAsset.id,
			skuKey: "nano-banana-2-lite-1k",
			aspectRatio: "auto",
		},
		pricingSnapshot: {
			credits: "5",
			skuKey: "nano-banana-2-lite-1k",
			routeGraph: kieNanoBanana2LiteRouteGraph(),
		},
		expiresAt: new Date(Date.now() + 60_000),
	} as const;
	const quote = await createModeratedGenerationQuoteTransaction(
		{
			...quoteInput,
			moderation: {
				decision: "ALLOW",
				provider: "test",
				ruleVersion: "TEST_OUTPUT_TRANSFER_RUNTIME_V1",
				reasonCode: "TEST_ALLOW_OUTPUT_TRANSFER",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
			},
		},
		client,
	);
	const created = await createGenerationJobTransaction(
		{
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `output-transfer-job:${suffix}`,
			inputAssetIds: [inputAsset.id],
			expectedModerationRuleVersion: "TEST_OUTPUT_TRANSFER_RUNTIME_V1",
			expectedAssetModerationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			expectedAssetModerationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		},
		client,
	);
	const dispatchStore = createDatabaseDispatchStore(client, {
		createSignedReadUrl: async () => "https://private.example/output-transfer-input.png",
	});
	const dispatch = await dispatchStore.claimDispatch({ jobId: created.job.id, version: 0 });
	if (!dispatch) throw new Error("Expected dispatch claim");
	await dispatchStore.recordSynchronousCompletion(
		dispatch.attemptId,
		{
			outcome: "accepted",
			providerTaskId: dispatch.attemptId,
			status: "SUCCEEDED",
			idempotency: { key: dispatch.attemptId, providerSupported: false, replayed: false },
			reconciliation: { submissionToken: dispatch.attemptId },
		},
		{
			outputs,
			progress: 100,
			providerCostMicros: 20_000,
			failure: null,
			retryable: false,
			providerCharged: true,
		},
	);
	const job = await client.generationJob.findUniqueOrThrow({ where: { id: created.job.id } });
	return { jobId: job.id, ownerId, version: job.version };
}

function kieNanoBanana2LiteRouteGraph() {
	const snapshot = createRouteGraphSnapshot({
		productKey: "image-nano-banana-2-lite",
		catalogVersion: DEFAULT_PRODUCT_CONFIG.catalogVersion,
		pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
		routes: [
			{
				provider: "kie",
				providerModelId: "nano-banana-2-lite",
				providerCostMicros: 20_000,
				weight: 100,
			},
		],
	});
	return {
		allowedRoutes: snapshot.allowedRoutes.map((route) => ({
			provider: route.provider,
			providerModelId: route.providerModelId,
			providerCostMicros: route.providerCostMicros,
			weight: route.weight,
		})),
		graphFingerprint: snapshot.graphFingerprint,
		maximumRouteCostMicros: snapshot.maximumRouteCostMicros,
	};
}

async function markSeededJobAsGuest(
	seeded: { jobId: string; ownerId: string },
	deleteAfter: Date,
): Promise<void> {
	const suffix = crypto.randomUUID();
	const createdAt = new Date(deleteAfter.getTime() - 120_000);
	const projectedDispatchAt = new Date(createdAt.getTime() + 60_000);
	const estimateExpiresAt = new Date(deleteAfter.getTime() - 1);
	await client.user.create({
		data: {
			id: seeded.ownerId,
			name: "Guest",
			email: `${suffix}@anonymous.invalid`,
			emailVerified: false,
			isAnonymous: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	const trial = await client.guestMediaTrial.create({
		data: {
			ownerId: seeded.ownerId,
			promotionPeriod: `finalization-${suffix}`,
			eligibility: "CONSUMED",
			sponsorCredits: 4n,
			sourceSessionHash: `session-${suffix}`,
			deviceHash: `device-${suffix}`,
			ipHash: `ip-${suffix}`,
			subnetHash: `subnet-${suffix}`,
			capabilityVersion: "guest-finalization-test-v1",
			idempotencyFingerprint: `fingerprint-${suffix}`,
			abuseEvidenceExpiresAt: new Date(createdAt.getTime() + 30 * 24 * 60 * 60_000),
			frozenQuotedRiskMicros: 20_000n,
			riskState: "COMMITTED",
			projectedDispatchAt,
			estimateExpiresAt,
			consumedJobId: seeded.jobId,
			providerBoundaryAt: projectedDispatchAt,
			consumedAt: projectedDispatchAt,
			createdAt,
			updatedAt: projectedDispatchAt,
			expiresAt: deleteAfter,
		},
	});
	await client.generationJob.update({
		where: { id: seeded.jobId },
		data: {
			productKey: "image-nano-banana-2-lite",
			serviceClass: "GUEST_SLOW",
			guestTrialId: trial.id,
		},
	});
}

function assertSafeTestDatabaseUrl(value: string | undefined): void {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	const databaseName = parsed.pathname.slice(1).toLowerCase();
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		parsed.port !== "55432" ||
		!/(^|[_-])(test|testing)([_-]|$)/u.test(databaseName) ||
		["postgres", "template0", "template1"].includes(databaseName)
	) {
		throw new Error("TEST_DATABASE_URL must target a local test database on port 55432");
	}
}
