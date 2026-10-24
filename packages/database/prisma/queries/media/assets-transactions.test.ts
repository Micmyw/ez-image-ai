import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("explicit client required");
	},
}));

import {
	abortMediaUploadSessionTransaction,
	claimGenerationOutputTransferTransaction,
	claimMediaUploadSessionFinalizationTransaction,
	completeMediaUploadSessionTransaction,
	createGenerationOutputAssetBindingTransaction,
	createMediaUploadSessionTransaction,
	failMediaUploadSessionFinalizationTransaction,
	markMediaAssetDeletedTransaction,
	renewMediaUploadSessionFinalizationLeaseTransaction,
} from "./assets";

type OutputBindingWriter = "legacy-binding" | "serializable-claim" | "fresh-read-claim";

function outputBindingClient(eligible: boolean) {
	const events: string[] = [];
	const tx = {
		$executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
			const sql = strings.join("?");
			if (sql.includes('UPDATE "generation_job"')) {
				events.push("job-fence");
				return eligible ? 1 : 0;
			}
			events.push("binding-lock");
			return 1;
		}),
		$queryRaw: vi.fn(async () => {
			events.push("asset-lock");
			return [];
		}),
		generationJob: {
			// A stale eligibility read must not authorize a new binding when the
			// conditional job write has already observed a terminal/foreign job.
			findFirst: vi.fn(async () => ({ id: "job_1", serviceClass: "STANDARD" })),
		},
		mediaAsset: {
			findUnique: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		generationJobAsset: {
			upsert: vi.fn(async () => ({ id: "binding_1" })),
		},
	};
	const client = {
		$transaction: vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx)),
	};
	return { client, tx, events };
}

function writeOutputBinding(
	writer: OutputBindingWriter,
	client: ReturnType<typeof outputBindingClient>["client"],
	streamingTransfersOnly = false,
) {
	vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", writer === "fresh-read-claim" ? "true" : "false");
	const asset = {
		id: "asset_1",
		ownerId: "user_1",
		objectKey: "users/user_1/output.png",
		mimeType: "image/png",
		byteSize: 10n,
		checksum: "a".repeat(64),
		sourceUrl: "provider-output:attempt_1:0",
	};
	if (writer === "legacy-binding")
		return createGenerationOutputAssetBindingTransaction(
			{ jobId: "job_1", asset },
			client as never,
		);
	return claimGenerationOutputTransferTransaction(
		{
			jobId: "job_1",
			assetId: asset.id,
			ownerId: asset.ownerId,
			objectKey: asset.objectKey,
			mimeType: asset.mimeType,
			sourceUrl: asset.sourceUrl,
			streamingTransfersOnly,
			createStagingObjectKey: (token) => `users/user_1/staging/${token}.png`,
			now: new Date("2026-10-22T00:00:00Z"),
		},
		client as never,
	);
}

describe("generation output binding job fences", () => {
	afterEach(() => vi.unstubAllEnvs());

	it.each<OutputBindingWriter>(["legacy-binding", "serializable-claim", "fresh-read-claim"])(
		"%s owns the eligible job before acquiring any binding or asset lock",
		async (writer) => {
			const { client, tx, events } = outputBindingClient(true);
			const result = await writeOutputBinding(writer, client);
			if (writer !== "legacy-binding") expect(result).toMatchObject({ freshAsset: true });
			expect(events.slice(0, 2)).toEqual(["job-fence", "binding-lock"]);
			expect(tx.generationJobAsset.upsert).toHaveBeenCalledOnce();
			expect(client.$transaction).toHaveBeenCalledWith(
				expect.any(Function),
				expect.objectContaining({
					isolationLevel: writer === "fresh-read-claim" ? "ReadCommitted" : "Serializable",
				}),
			);
		},
	);

	it.each<OutputBindingWriter>(["serializable-claim", "fresh-read-claim"])(
		"%s never labels an existing zero-byte placeholder as a fresh asset",
		async (writer) => {
			const { client, tx } = outputBindingClient(true);
			tx.mediaAsset.findUnique.mockResolvedValueOnce({
				id: "asset_1",
				ownerType: "USER",
				ownerId: "user_1",
				kind: "OUTPUT",
				verificationEngine: "legacy",
				status: "VERIFYING",
				byteSize: 0n,
				checksum: null,
				objectKey: "users/user_1/output.png",
				mimeType: "image/png",
				sourceUrl: "provider-output:attempt_1:0",
				retentionClass: "ACCOUNT",
				deleteAfter: null,
				deletedAt: null,
				finalizedAt: null,
				outputTransferToken: null,
			});
			expect(await writeOutputBinding(writer, client)).toMatchObject({
				outcome: "CLAIMED",
				freshAsset: false,
			});
			expect(tx.mediaAsset.create).not.toHaveBeenCalled();
		},
	);

	it.each<OutputBindingWriter>(["legacy-binding", "serializable-claim", "fresh-read-claim"])(
		"%s cannot create an output from stale eligibility after its job fence loses",
		async (writer) => {
			const { client, tx, events } = outputBindingClient(false);
			await expect(writeOutputBinding(writer, client)).rejects.toThrow(
				"GENERATION_JOB_NOT_FINALIZING_FOR_OUTPUT",
			);
			expect(events).toEqual(["job-fence"]);
			expect(tx.mediaAsset.create).not.toHaveBeenCalled();
			expect(tx.generationJobAsset.upsert).not.toHaveBeenCalled();
		},
	);

	it.each<OutputBindingWriter>(["serializable-claim", "fresh-read-claim"])(
		"%s preserves REQUIRES_HEAVY when a streaming-only job fence loses",
		async (writer) => {
			const { client, tx, events } = outputBindingClient(false);
			await expect(writeOutputBinding(writer, client, true)).resolves.toEqual({
				outcome: "REQUIRES_HEAVY",
			});
			expect(events).toEqual(["job-fence"]);
			expect(tx.mediaAsset.create).not.toHaveBeenCalled();
			expect(tx.generationJobAsset.upsert).not.toHaveBeenCalled();
		},
	);
});

function transactionClient(overrides: Record<string, unknown> = {}) {
	const tx = {
		subscription: { findMany: vi.fn(async () => []) },
		billingPeriod: { fields: { paidAmount: "paidAmount" } },
		mediaAsset: {
			create: vi.fn(async ({ data }) => ({ ...data, status: "UPLOADING" })),
			findFirst: vi.fn(async () => ({
				id: "asset_1",
				ownerType: "USER",
				ownerId: "user_1",
				objectKey: "users/user_1/assets/asset_1/original.mp4",
				status: "READY",
				deletedAt: null,
			})),
			update: vi.fn(async ({ data }) => ({ id: "asset_1", verificationEngine: "legacy", ...data })),
		},
		mediaUploadSession: {
			create: vi.fn(async ({ data }) => ({ ...data, status: "PENDING" })),
			count: vi.fn(async () => 0),
			findFirst: vi.fn(
				async (): Promise<Record<string, unknown>> => ({
					id: "session_1",
					status: "PENDING",
					expiresAt: new Date("2026-08-14T00:00:00Z"),
					assetId: "asset_1",
					multipartUploadId: null as string | null,
					stagingObjectKey: "users/user_1/staging/session_1/nonce.png",
					stagedTerminalizationToken: "staged-terminalization-token",
					finalizationToken: null,
					finalizationLeaseExpiresAt: null,
					finalizationParts: null,
					asset: {
						id: "asset_1",
						ownerType: "USER",
						ownerId: "user_1",
						status: "UPLOADING",
						objectKey: "users/user_1/assets/asset_1/original.mp4",
						mimeType: "video/mp4",
					},
				}),
			),
			update: vi.fn(async ({ data }) => ({ id: "session_1", ...data })),
			updateMany: vi.fn(async (_input: { data?: Record<string, unknown> }) => ({ count: 1 })),
		},
		generationJobAsset: {
			findFirst: vi.fn(async () => null),
		},
		storageUsageReservation: {
			create: vi.fn(async ({ data }) => ({ id: "reservation_1", ...data })),
			aggregate: vi.fn(async () => ({ _sum: { bytes: 100n } })),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		$executeRaw: vi.fn(async () => 1),
		$queryRaw: vi.fn(async () => [{ now: new Date("2026-08-13T00:00:00Z") }]),
		outboxEvent: { create: vi.fn(async ({ data }) => data) },
		auditLog: { create: vi.fn(async ({ data }) => data) },
		...overrides,
	};
	return {
		tx,
		client: {
			$transaction: vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) =>
				operation(tx),
			),
		},
	};
}

describe("media upload transactions", () => {
	it("atomically creates the uploading asset, session, reservation, and audit row", async () => {
		const { client, tx } = transactionClient();
		await createMediaUploadSessionTransaction(
			{
				assetId: "asset_1",
				sessionId: "session_1",
				ownerType: "USER",
				ownerId: "user_1",
				kind: "INPUT",
				objectKey: "users/user_1/assets/asset_1/original.png",
				stagingObjectKey: "users/user_1/staging/session_1/nonce.png",
				mimeType: "image/png",
				expectedBytes: 123n,
				tokenHash: "token_hash",
				expiresAt: new Date("2026-08-14T00:00:00Z"),
				multipartUploadId: null,
				limits: { maximumActiveSessions: 3, maximumReservedBytes: 1000n },
			},
			client as never,
		);
		expect(tx.storageUsageReservation.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				ownerType: "USER",
				ownerId: "user_1",
				bytes: 123n,
				referenceKey: "media-upload:session_1",
			}),
		});
		expect(tx.auditLog.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ action: "MEDIA_UPLOAD_SESSION_CREATED" }),
		});
	});

	it("rejects a session whose staging key could overwrite its final asset", async () => {
		const { client, tx } = transactionClient();
		await expect(
			createMediaUploadSessionTransaction(
				{
					assetId: "asset_same_key",
					sessionId: "session_same_key",
					ownerType: "USER",
					ownerId: "user_1",
					kind: "INPUT",
					objectKey: "users/user_1/assets/asset_same_key/original.png",
					stagingObjectKey: "users/user_1/assets/asset_same_key/original.png",
					mimeType: "image/png",
					expectedBytes: 123n,
					tokenHash: "token_same_key",
					expiresAt: new Date("2026-08-14T00:00:00Z"),
					multipartUploadId: null,
					limits: { maximumActiveSessions: 3, maximumReservedBytes: 1000n },
				},
				client as never,
			),
		).rejects.toThrow("Staging upload key must differ from final asset key");
		expect(tx.mediaAsset.create).not.toHaveBeenCalled();
		expect(tx.mediaUploadSession.create).not.toHaveBeenCalled();
	});

	it("rejects a session before writes when aggregate storage quota would be exceeded", async () => {
		const { client, tx } = transactionClient({
			mediaUploadSession: {
				create: vi.fn(),
				count: vi.fn(async () => 1),
			},
		});
		tx.storageUsageReservation.aggregate.mockResolvedValueOnce({ _sum: { bytes: 900n } });

		await expect(
			createMediaUploadSessionTransaction(
				{
					assetId: "asset_2",
					sessionId: "session_2",
					ownerType: "USER",
					ownerId: "user_1",
					kind: "INPUT",
					objectKey: "users/user_1/assets/asset_2/original.png",
					stagingObjectKey: "users/user_1/staging/session_2/nonce.png",
					mimeType: "image/png",
					expectedBytes: 200n,
					tokenHash: "token_hash_2",
					expiresAt: new Date("2026-08-14T00:00:00Z"),
					multipartUploadId: null,
					limits: { maximumActiveSessions: 3, maximumReservedBytes: 1000n },
				},
				client as never,
			),
		).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
		expect(tx.mediaAsset.create).not.toHaveBeenCalled();
		expect(tx.storageUsageReservation.create).not.toHaveBeenCalled();
	});

	it("ends a finalized invalid upload and queues object deletion", async () => {
		const { failMediaUploadSessionTransaction } = await import("./assets");
		const { client, tx } = transactionClient();
		await failMediaUploadSessionTransaction(
			{ sessionId: "session_1", ownerId: "user_1", reason: "UPLOAD_VALIDATION_FAILED" },
			client as never,
		);
		expect(tx.mediaUploadSession.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "ABORTED",
					stagedTerminalizationToken: null,
				}),
			}),
		);
		expect(tx.mediaAsset.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "DELETED" }) }),
		);
		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: "MEDIA_UPLOAD_CLEANUP",
				dedupeKey: "media-upload-invalid-cleanup:session_1",
			}),
		});
	});

	it("video upload seals bytes but leaves moderation to its workflow", async () => {
		const { client, tx } = transactionClient();
		tx.mediaUploadSession.findFirst.mockResolvedValueOnce({
			id: "session_1",
			status: "FINALIZING",
			assetId: "asset_1",
			multipartUploadId: null,
			stagingObjectKey: "users/user_1/staging/session_1/nonce.png",
			finalizationToken: "finalize_1",
			finalizationLeaseExpiresAt: new Date("2026-08-13T01:00:00Z"),
			asset: { id: "asset_1", status: "UPLOADING", verificationEngine: "video-workflow-v1" },
		});
		tx.mediaAsset.update.mockImplementationOnce(async ({ data }) => ({
			id: "asset_1",
			verificationEngine: "video-workflow-v1",
			...data,
		}));
		const result = await completeMediaUploadSessionTransaction(
			{
				sessionId: "session_1",
				ownerId: "user_1",
				checksum: "a".repeat(64),
				finalizationToken: "finalize_1",
				now: new Date("2026-08-13T00:00:00Z"),
			},
			client as never,
		);
		expect(result.status).toBe("VERIFYING");
		expect(result.checksum).toBe("a".repeat(64));
		expect(tx.outboxEvent.create).not.toHaveBeenCalledWith({
			data: expect.objectContaining({ eventType: "MEDIA_ASSET_VERIFY" }),
		});
		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ eventType: "MEDIA_UPLOAD_CLEANUP" }),
		});
	});

	it("completes idempotently into VERIFYING and queues verification", async () => {
		const { client, tx } = transactionClient();
		tx.mediaUploadSession.findFirst.mockResolvedValueOnce({
			id: "session_1",
			status: "FINALIZING",
			expiresAt: new Date("2026-08-14T00:00:00Z"),
			assetId: "asset_1",
			multipartUploadId: null,
			stagingObjectKey: "users/user_1/staging/session_1/nonce.png",
			finalizationToken: "finalize_1",
			finalizationLeaseExpiresAt: new Date("2026-08-13T01:00:00Z"),
			finalizationParts: null,
			asset: {
				id: "asset_1",
				ownerType: "USER",
				ownerId: "user_1",
				status: "UPLOADING",
				objectKey: "users/user_1/assets/asset_1/original.mp4",
				mimeType: "video/mp4",
			},
		});
		const first = await completeMediaUploadSessionTransaction(
			{
				sessionId: "session_1",
				ownerId: "user_1",
				checksum: "sha256",
				finalizationToken: "finalize_1",
				now: new Date("2026-08-13T00:00:00Z"),
			},
			client as never,
		);
		expect(first.status).toBe("VERIFYING");
		expect(tx.mediaAsset.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "VERIFYING" }) }),
		);
		expect(tx.storageUsageReservation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "COMMITTED" }) }),
		);
		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ eventType: "MEDIA_ASSET_VERIFY" }),
		});

		tx.mediaUploadSession.findFirst.mockResolvedValueOnce({
			id: "session_1",
			status: "COMPLETED",
			expiresAt: new Date("2026-08-14T00:00:00Z"),
			assetId: "asset_1",
			asset: {
				id: "asset_1",
				ownerType: "USER",
				ownerId: "user_1",
				status: "VERIFYING",
				objectKey: "key",
			},
		});
		await completeMediaUploadSessionTransaction(
			{
				sessionId: "session_1",
				ownerId: "user_1",
				checksum: "new",
				finalizationToken: "stale-token",
			},
			client as never,
		);
		expect(tx.mediaAsset.update).toHaveBeenCalledTimes(1);
	});

	it("claims exactly one FINALIZING transition before storage promotion", async () => {
		const { client, tx } = transactionClient();
		const claimed = await claimMediaUploadSessionFinalizationTransaction(
			{
				sessionId: "session_1",
				ownerId: "user_1",
				parts: [{ partNumber: 1, etag: "etag_1" }],
				now: new Date("2026-08-13T00:00:00Z"),
			},
			client as never,
		);
		expect(claimed.outcome).toBe("CLAIMED");
		expect(tx.mediaUploadSession.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ status: "PENDING" }),
				data: expect.objectContaining({
					status: "FINALIZING",
					finalizationToken: expect.any(String),
					finalizationLeaseExpiresAt: expect.any(Date),
				}),
			}),
		);
	});

	it("gives only one caller an active finalization lease and keeps the other caller out of storage work", async () => {
		const state = {
			id: "session_1",
			status: "PENDING",
			expiresAt: new Date("2026-08-14T00:00:00Z"),
			assetId: "asset_1",
			multipartUploadId: null,
			stagingObjectKey: "users/user_1/staging/session_1/nonce.png",
			finalizationToken: null,
			finalizationLeaseExpiresAt: null,
			finalizationParts: null,
			asset: {
				id: "asset_1",
				ownerType: "USER",
				ownerId: "user_1",
				status: "UPLOADING",
				objectKey: "users/user_1/assets/asset_1/original.png",
			},
		};
		let successfulClaims = 0;
		const { client, tx } = transactionClient({
			mediaUploadSession: {
				findFirst: vi.fn(async () => ({ ...state })),
				updateMany: vi.fn(async ({ where, data }) => {
					if (where.status !== state.status) return { count: 0 };
					Object.assign(state, data);
					successfulClaims += 1;
					return { count: 1 };
				}),
			},
		});

		const now = new Date("2026-08-13T00:00:00Z");
		const [first, second] = await Promise.all([
			claimMediaUploadSessionFinalizationTransaction(
				{ sessionId: "session_1", ownerId: "user_1", now },
				client as never,
			),
			claimMediaUploadSessionFinalizationTransaction(
				{ sessionId: "session_1", ownerId: "user_1", now },
				client as never,
			),
		]);

		const claims = [first, second];
		expect(claims.filter((claim) => claim.outcome === "CLAIMED")).toHaveLength(1);
		expect(claims.filter((claim) => claim.outcome === "IN_PROGRESS")).toHaveLength(1);
		expect(state.finalizationToken).toEqual(expect.any(String));
		expect(state.finalizationLeaseExpiresAt).toBeInstanceOf(Date);
		expect(successfulClaims).toBe(1);
		expect(tx.mediaUploadSession.updateMany).toHaveBeenCalledTimes(2);
	});

	it("reclaims an expired finalization lease without replacing persisted multipart parts", async () => {
		const persistedParts = [{ partNumber: 1, etag: "persisted-etag" }];
		const { client, tx } = transactionClient({
			mediaUploadSession: {
				findFirst: vi.fn(async () => ({
					id: "session_1",
					status: "FINALIZING",
					expiresAt: new Date("2026-08-13T00:10:00Z"),
					assetId: "asset_1",
					multipartUploadId: "multipart_1",
					stagingObjectKey: "users/user_1/staging/session_1/nonce.mp4",
					finalizationToken: "expired-token",
					finalizationLeaseExpiresAt: new Date("2026-08-13T00:04:00Z"),
					finalizationParts: persistedParts,
					asset: {
						id: "asset_1",
						ownerType: "USER",
						ownerId: "user_1",
						status: "UPLOADING",
						objectKey: "users/user_1/assets/asset_1/original.mp4",
					},
				})),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
		});

		const claimed = await claimMediaUploadSessionFinalizationTransaction(
			{
				sessionId: "session_1",
				ownerId: "user_1",
				now: new Date("2026-08-13T00:05:00Z"),
				parts: [{ partNumber: 1, etag: "attacker-supplied-etag" }],
			},
			client as never,
		);

		expect(claimed).toMatchObject({
			outcome: "CLAIMED",
			finalizationParts: persistedParts,
		});
		expect(tx.mediaUploadSession.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ status: "FINALIZING" }),
				data: expect.objectContaining({
					finalizationToken: expect.not.stringMatching(/^expired-token$/),
				}),
			}),
		);
		expect(vi.mocked(tx.mediaUploadSession.updateMany).mock.calls[0]?.[0].data).not.toHaveProperty(
			"finalizationParts",
		);
	});

	it("renews only the active matching lease before destructive multipart recovery", async () => {
		const { client, tx } = transactionClient({
			mediaUploadSession: {
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
		});
		const now = new Date("2026-08-13T00:05:00Z");

		await expect(
			renewMediaUploadSessionFinalizationLeaseTransaction(
				{
					sessionId: "session_1",
					ownerId: "user_1",
					finalizationToken: "finalize_1",
					now,
					leaseDurationMs: 1_000,
				},
				client as never,
			),
		).resolves.toEqual({ finalizationLeaseExpiresAt: new Date("2026-08-13T00:05:01Z") });
		expect(tx.mediaUploadSession.updateMany).toHaveBeenCalledWith({
			where: {
				id: "session_1",
				asset: { ownerType: "USER", ownerId: "user_1" },
				status: "FINALIZING",
				finalizationToken: "finalize_1",
				finalizationLeaseExpiresAt: { gt: now },
				promotionMultipartUploadId: null,
				promotionToken: null,
			},
			data: { finalizationLeaseExpiresAt: new Date("2026-08-13T00:05:01Z") },
		});
	});

	it("rejects a stale finalization token before destructive multipart recovery", async () => {
		const { client } = transactionClient({
			mediaUploadSession: {
				updateMany: vi.fn(async () => ({ count: 0 })),
			},
		});

		await expect(
			renewMediaUploadSessionFinalizationLeaseTransaction(
				{
					sessionId: "session_1",
					ownerId: "user_1",
					finalizationToken: "stale-token",
					now: new Date("2026-08-13T00:05:00Z"),
				},
				client as never,
			),
		).rejects.toThrow(/not owned/i);
	});

	it("fails closed instead of reclaiming a FINALIZING row without a lease", async () => {
		const { client, tx } = transactionClient({
			mediaUploadSession: {
				findFirst: vi.fn(async () => ({
					id: "session_1",
					status: "FINALIZING",
					expiresAt: new Date("2026-08-13T00:00:00Z"),
					assetId: "asset_1",
					multipartUploadId: null,
					stagingObjectKey: "users/user_1/staging/session_1/nonce.png",
					finalizationToken: "legacy-token",
					finalizationLeaseExpiresAt: null,
					finalizationParts: null,
					asset: {
						id: "asset_1",
						ownerType: "USER",
						ownerId: "user_1",
						status: "UPLOADING",
						objectKey: "users/user_1/assets/asset_1/original.png",
					},
				})),
				updateMany: vi.fn(),
			},
		});

		await expect(
			claimMediaUploadSessionFinalizationTransaction(
				{ sessionId: "session_1", ownerId: "user_1", now: new Date("2026-08-13T00:05:00Z") },
				client as never,
			),
		).resolves.toMatchObject({ outcome: "IN_PROGRESS", asset: { id: "asset_1" } });
		expect(tx.mediaUploadSession.updateMany).not.toHaveBeenCalled();
	});

	it("terminalizes deterministic finalization failure only when the caller still owns its lease", async () => {
		const { client, tx } = transactionClient({
			mediaUploadSession: {
				findFirst: vi.fn(async () => ({
					id: "session_1",
					status: "FINALIZING",
					expiresAt: new Date("2026-08-14T00:00:00Z"),
					assetId: "asset_1",
					multipartUploadId: null,
					stagingObjectKey: "users/user_1/staging/session_1/nonce.png",
					finalizationToken: "finalize_1",
					finalizationLeaseExpiresAt: new Date("2026-08-13T00:10:00Z"),
					finalizationParts: null,
					asset: {
						id: "asset_1",
						ownerType: "USER",
						ownerId: "user_1",
						status: "UPLOADING",
						objectKey: "users/user_1/assets/asset_1/original.png",
					},
				})),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
		});
		const now = new Date("2026-08-13T00:05:00Z");

		await expect(
			failMediaUploadSessionFinalizationTransaction(
				{
					sessionId: "session_1",
					ownerId: "user_1",
					finalizationToken: "finalize_1",
					reason: "UPLOAD_FINALIZATION_VALIDATION_FAILED",
					now,
				},
				client as never,
			),
		).resolves.toMatchObject({ id: "asset_1", status: "DELETED" });
		expect(tx.mediaUploadSession.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: "FINALIZING",
					finalizationToken: "finalize_1",
					finalizationLeaseExpiresAt: { gt: now },
				}),
				data: expect.objectContaining({
					status: "ABORTED",
					finalizationToken: null,
					finalizationLeaseExpiresAt: null,
					stagedTerminalizationToken: null,
				}),
			}),
		);
		expect(tx.storageUsageReservation.updateMany).not.toHaveBeenCalled();
		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				dedupeKey: "media-upload-finalization-failure-cleanup:session_1",
				availableAt: new Date("2026-08-13T00:15:00Z"),
				payload: expect.objectContaining({
					uploadSessionId: "session_1",
					reservationStatus: "RELEASED",
				}),
			}),
		});
	});

	it("allows an active finalization lease to complete after the upload URL expires", async () => {
		const { client, tx } = transactionClient({
			mediaUploadSession: {
				findFirst: vi.fn(async () => ({
					id: "session_1",
					status: "FINALIZING",
					expiresAt: new Date("2026-08-13T00:00:00Z"),
					assetId: "asset_1",
					multipartUploadId: null,
					stagingObjectKey: "users/user_1/staging/session_1/nonce.png",
					finalizationToken: "active-token",
					finalizationLeaseExpiresAt: new Date("2026-08-13T00:10:00Z"),
					asset: {
						id: "asset_1",
						ownerType: "USER",
						ownerId: "user_1",
						status: "UPLOADING",
						objectKey: "users/user_1/assets/asset_1/original.png",
					},
				})),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
		} as never);

		await expect(
			completeMediaUploadSessionTransaction(
				{
					sessionId: "session_1",
					ownerId: "user_1",
					checksum: "sha256",
					finalizationToken: "active-token",
					now: new Date("2026-08-13T00:05:00Z"),
				},
				client as never,
			),
		).resolves.toMatchObject({ status: "VERIFYING" });
		expect(tx.mediaUploadSession.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					finalizationToken: "active-token",
					finalizationLeaseExpiresAt: { gt: new Date("2026-08-13T00:05:00Z") },
				}),
			}),
		);
	});

	it("rejects the exact expiration boundary and defers reservation release until cleanup", async () => {
		const boundary = new Date("2026-08-14T00:00:00Z");
		const { client, tx } = transactionClient();

		await expect(
			claimMediaUploadSessionFinalizationTransaction(
				{
					sessionId: "session_1",
					ownerId: "user_1",
					now: boundary,
				},
				client as never,
			),
		).rejects.toThrow(/expired/i);

		expect(tx.mediaUploadSession.updateMany).toHaveBeenCalledWith({
			where: {
				id: "session_1",
				status: "PENDING",
				expiresAt: { lte: boundary },
				stagedTerminalizationToken: "staged-terminalization-token",
			},
			data: expect.objectContaining({ status: "EXPIRED", stagedTerminalizationToken: null }),
		});
		expect(tx.storageUsageReservation.updateMany).not.toHaveBeenCalled();
		expect(tx.mediaAsset.update).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "VERIFYING" }) }),
		);
		expect(tx.outboxEvent.create).not.toHaveBeenCalledWith({
			data: expect.objectContaining({ eventType: "MEDIA_ASSET_VERIFY" }),
		});
		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: "MEDIA_UPLOAD_CLEANUP",
				availableAt: new Date(boundary.getTime() + 10 * 60 * 1_000),
				payload: expect.objectContaining({
					uploadSessionId: "session_1",
					reservationStatus: "EXPIRED",
				}),
			}),
		});
	});

	it("fails closed when the pending completion CAS loses a concurrent race", async () => {
		const { client, tx } = transactionClient();
		tx.mediaUploadSession.findFirst.mockResolvedValueOnce({
			id: "session_1",
			status: "FINALIZING",
			expiresAt: new Date("2026-08-14T00:00:00Z"),
			assetId: "asset_1",
			multipartUploadId: null,
			stagingObjectKey: "users/user_1/staging/session_1/nonce.png",
			finalizationToken: "finalize_1",
			finalizationLeaseExpiresAt: new Date("2026-08-13T01:00:00Z"),
			asset: {
				id: "asset_1",
				ownerType: "USER",
				ownerId: "user_1",
				status: "UPLOADING",
				objectKey: "users/user_1/assets/asset_1/original.mp4",
				mimeType: "video/mp4",
			},
		});
		tx.mediaUploadSession.updateMany.mockResolvedValueOnce({ count: 0 });

		await expect(
			completeMediaUploadSessionTransaction(
				{
					sessionId: "session_1",
					ownerId: "user_1",
					checksum: "sha256",
					finalizationToken: "finalize_1",
					now: new Date("2026-08-13T00:00:00Z"),
				},
				client as never,
			),
		).rejects.toThrow(/concurrently/i);

		expect(tx.mediaAsset.update).not.toHaveBeenCalled();
		expect(tx.storageUsageReservation.updateMany).not.toHaveBeenCalled();
		expect(tx.outboxEvent.create).not.toHaveBeenCalled();
	});

	it("expires a multipart claim by queuing a staging multipart abort", async () => {
		const boundary = new Date("2026-08-14T00:00:00Z");
		const { client, tx } = transactionClient();
		tx.mediaUploadSession.findFirst.mockResolvedValueOnce({
			id: "session_1",
			status: "PENDING",
			expiresAt: boundary,
			assetId: "asset_1",
			multipartUploadId: "multipart_1",
			stagingObjectKey: "users/user_1/staging/session_1/nonce.mp4",
			stagedTerminalizationToken: "staged-terminalization-token",
			finalizationToken: null,
			finalizationLeaseExpiresAt: null,
			finalizationParts: null,
			asset: {
				id: "asset_1",
				ownerType: "USER",
				ownerId: "user_1",
				status: "UPLOADING",
				objectKey: "users/user_1/assets/asset_1/original.mp4",
				mimeType: "video/mp4",
			},
		});

		await expect(
			claimMediaUploadSessionFinalizationTransaction(
				{ sessionId: "session_1", ownerId: "user_1", now: boundary },
				client as never,
			),
		).rejects.toThrow(/expired/i);

		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: "MEDIA_UPLOAD_CLEANUP",
				availableAt: new Date(boundary.getTime() + 10 * 60 * 1_000),
				payload: expect.objectContaining({
					objectKey: "users/user_1/staging/session_1/nonce.mp4",
					multipartUploadId: "multipart_1",
				}),
			}),
		});
	});

	it("aborts upload and defers reservation release until durable staging cleanup", async () => {
		const { client, tx } = transactionClient();
		await abortMediaUploadSessionTransaction(
			{ sessionId: "session_1", ownerId: "user_1" },
			client as never,
		);
		expect(tx.mediaUploadSession.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: "PENDING",
					stagedTerminalizationToken: "staged-terminalization-token",
				}),
				data: expect.objectContaining({
					status: "ABORTED",
					stagedTerminalizationToken: null,
				}),
			}),
		);
		expect(tx.mediaAsset.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "DELETED" }) }),
		);
		expect(tx.storageUsageReservation.updateMany).not.toHaveBeenCalled();
		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: "MEDIA_UPLOAD_CLEANUP",
				dedupeKey: "media-upload-abort-cleanup:session_1",
				payload: expect.objectContaining({
					assetId: "asset_1",
					objectKey: "users/user_1/staging/session_1/nonce.png",
					cleanupObjectKeys: ["users/user_1/assets/asset_1/original.mp4"],
					promotionObjectKey: "users/user_1/assets/asset_1/original.mp4",
					uploadSessionId: "session_1",
					reservationStatus: "RELEASED",
				}),
				availableAt: new Date("2026-08-13T00:10:00Z"),
			}),
		});
	});

	it("queues multipart abort instead of object delete for a multipart session", async () => {
		const { client, tx } = transactionClient();
		tx.mediaUploadSession.findFirst.mockResolvedValueOnce({
			id: "session_1",
			status: "PENDING",
			expiresAt: new Date("2026-08-14T00:00:00Z"),
			assetId: "asset_1",
			multipartUploadId: "multipart_1",
			stagingObjectKey: "users/user_1/staging/session_1/nonce.mp4",
			stagedTerminalizationToken: "staged-terminalization-token",
			asset: {
				id: "asset_1",
				ownerType: "USER",
				ownerId: "user_1",
				status: "UPLOADING",
				objectKey: "users/user_1/assets/asset_1/original.mp4",
			},
		});
		await abortMediaUploadSessionTransaction(
			{ sessionId: "session_1", ownerId: "user_1" },
			client as never,
		);
		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: "MEDIA_UPLOAD_CLEANUP",
				payload: expect.objectContaining({ multipartUploadId: "multipart_1" }),
			}),
		});
	});

	it("does not enqueue a duplicate cleanup event when abort is replayed", async () => {
		const { client, tx } = transactionClient();
		tx.mediaUploadSession.findFirst.mockResolvedValueOnce({
			id: "session_1",
			status: "ABORTED",
			expiresAt: new Date("2026-08-14T00:00:00Z"),
			assetId: "asset_1",
			multipartUploadId: "multipart_1",
			asset: {
				id: "asset_1",
				ownerType: "USER",
				ownerId: "user_1",
				status: "DELETED",
				objectKey: "users/user_1/assets/asset_1/original.mp4",
			},
		});
		await abortMediaUploadSessionTransaction(
			{ sessionId: "session_1", ownerId: "user_1" },
			client as never,
		);
		expect(tx.outboxEvent.create).not.toHaveBeenCalled();
		expect(tx.auditLog.create).not.toHaveBeenCalled();
	});

	it("marks an owned asset deleted before queuing physical deletion", async () => {
		const { client, tx } = transactionClient();
		tx.mediaUploadSession.findFirst.mockResolvedValueOnce({ id: "session_1" } as never);
		const result = await markMediaAssetDeletedTransaction(
			{
				assetId: "asset_1",
				ownerId: "user_1",
				now: new Date("2026-08-13T00:00:00Z"),
			},
			client as never,
		);
		expect(result.status).toBe("DELETED");
		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: "MEDIA_OBJECT_DELETE",
				availableAt: new Date("2026-08-14T00:00:00.000Z"),
				payload: expect.objectContaining({
					deleteBy: "2026-08-14T00:00:00.000Z",
					uploadSessionId: "session_1",
					reservationStatus: "RELEASED",
				}),
			}),
		});
		expect(tx.storageUsageReservation.updateMany).not.toHaveBeenCalled();
	});
	it("explicit temporary-image deletion retains its exact quota reservation until physical cleanup", async () => {
		const { client, tx } = transactionClient();
		tx.mediaAsset.findFirst.mockResolvedValueOnce({
			id: "asset_1",
			objectKey: "users/temporary-references/v1/user_1/asset_1",
			kind: "INPUT",
			status: "READY",
		} as never);
		tx.mediaUploadSession.findFirst.mockResolvedValueOnce(null as never);
		await markMediaAssetDeletedTransaction(
			{ assetId: "asset_1", ownerId: "user_1" },
			client as never,
		);
		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				payload: expect.objectContaining({
					storageReservationReferenceKey: "temporary-reference:asset_1",
				}),
			}),
		});
		expect(tx.storageUsageReservation.updateMany).not.toHaveBeenCalled();
	});

	it("refuses to delete an asset while its upload session can still write staging data", async () => {
		const { client, tx } = transactionClient({
			mediaAsset: {
				findFirst: vi.fn(async () => null),
				update: vi.fn(),
			},
		});

		await expect(
			markMediaAssetDeletedTransaction({ assetId: "asset_1", ownerId: "user_1" }, client as never),
		).rejects.toThrow(/not found/i);
		expect(tx.mediaAsset.findFirst).toHaveBeenCalledWith({
			where: expect.objectContaining({ status: { not: "UPLOADING" } }),
		});
		expect(tx.mediaAsset.update).not.toHaveBeenCalled();
		expect(tx.outboxEvent.create).not.toHaveBeenCalled();
	});
});
