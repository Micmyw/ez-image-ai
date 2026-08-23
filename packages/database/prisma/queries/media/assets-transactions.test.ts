import { describe, expect, it, vi } from "vitest";

import {
	abortMediaUploadSessionTransaction,
	completeMediaUploadSessionTransaction,
	createMediaUploadSessionTransaction,
	markMediaAssetDeletedTransaction,
} from "./assets";

function transactionClient(overrides: Record<string, unknown> = {}) {
	const tx = {
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
			update: vi.fn(async ({ data }) => ({ id: "asset_1", ...data })),
		},
		mediaUploadSession: {
			create: vi.fn(async ({ data }) => ({ ...data, status: "PENDING" })),
			count: vi.fn(async () => 0),
			findFirst: vi.fn(async () => ({
				id: "session_1",
				status: "PENDING",
				expiresAt: new Date("2026-08-14T00:00:00Z"),
				assetId: "asset_1",
				multipartUploadId: null as string | null,
				asset: {
					id: "asset_1",
					ownerType: "USER",
					ownerId: "user_1",
					status: "UPLOADING",
					objectKey: "users/user_1/assets/asset_1/original.mp4",
				},
			})),
			update: vi.fn(async ({ data }) => ({ id: "session_1", ...data })),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		storageUsageReservation: {
			create: vi.fn(async ({ data }) => ({ id: "reservation_1", ...data })),
			aggregate: vi.fn(async () => ({ _sum: { bytes: 100n } })),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		$executeRaw: vi.fn(async () => 1),
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
			expect.objectContaining({ data: { status: "ABORTED" } }),
		);
		expect(tx.mediaAsset.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "DELETED" }) }),
		);
		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: "MEDIA_OBJECT_DELETE",
				dedupeKey: "media-upload-invalid-cleanup:session_1",
			}),
		});
	});

	it("completes idempotently into VERIFYING and queues verification", async () => {
		const { client, tx } = transactionClient();
		const first = await completeMediaUploadSessionTransaction(
			{
				sessionId: "session_1",
				ownerId: "user_1",
				checksum: "sha256",
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
		} as never);
		await completeMediaUploadSessionTransaction(
			{ sessionId: "session_1", ownerId: "user_1", checksum: "new" },
			client as never,
		);
		expect(tx.mediaAsset.update).toHaveBeenCalledTimes(1);
	});

	it("rejects the exact expiration boundary and atomically expires the reservation", async () => {
		const boundary = new Date("2026-08-14T00:00:00Z");
		const { client, tx } = transactionClient();

		await expect(
			completeMediaUploadSessionTransaction(
				{
					sessionId: "session_1",
					ownerId: "user_1",
					checksum: "sha256",
					now: boundary,
					expiredCleanup: "DELETE_OBJECT",
				},
				client as never,
			),
		).rejects.toThrow(/expired/i);

		expect(tx.mediaUploadSession.updateMany).toHaveBeenCalledWith({
			where: { id: "session_1", status: "PENDING", expiresAt: { lte: boundary } },
			data: { status: "EXPIRED" },
		});
		expect(tx.storageUsageReservation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "EXPIRED" }) }),
		);
		expect(tx.mediaAsset.update).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "VERIFYING" }) }),
		);
		expect(tx.outboxEvent.create).not.toHaveBeenCalledWith({
			data: expect.objectContaining({ eventType: "MEDIA_ASSET_VERIFY" }),
		});
		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ eventType: "MEDIA_OBJECT_DELETE" }),
		});
	});

	it("fails closed when the pending completion CAS loses a concurrent race", async () => {
		const { client, tx } = transactionClient();
		tx.mediaUploadSession.updateMany.mockResolvedValueOnce({ count: 0 });

		await expect(
			completeMediaUploadSessionTransaction(
				{
					sessionId: "session_1",
					ownerId: "user_1",
					checksum: "sha256",
					now: new Date("2026-08-13T00:00:00Z"),
				},
				client as never,
			),
		).rejects.toThrow(/concurrently/i);

		expect(tx.mediaAsset.update).not.toHaveBeenCalled();
		expect(tx.storageUsageReservation.updateMany).not.toHaveBeenCalled();
		expect(tx.outboxEvent.create).not.toHaveBeenCalled();
	});

	it("aborts upload and releases its reservation in one transaction", async () => {
		const { client, tx } = transactionClient();
		await abortMediaUploadSessionTransaction(
			{ sessionId: "session_1", ownerId: "user_1" },
			client as never,
		);
		expect(tx.mediaUploadSession.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "ABORTED" }) }),
		);
		expect(tx.mediaAsset.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "DELETED" }) }),
		);
		expect(tx.storageUsageReservation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "RELEASED" }) }),
		);
		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: "MEDIA_OBJECT_DELETE",
				dedupeKey: "media-upload-abort-cleanup:session_1",
				payload: {
					assetId: "asset_1",
					objectKey: "users/user_1/assets/asset_1/original.mp4",
				},
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
				eventType: "MEDIA_MULTIPART_ABORT",
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
				payload: expect.objectContaining({ deleteBy: "2026-08-14T00:00:00.000Z" }),
			}),
		});
		expect(tx.storageUsageReservation.updateMany).toHaveBeenCalledWith({
			where: {
				referenceKey: "media-upload:session_1",
				status: { in: ["ACTIVE", "COMMITTED"] },
			},
			data: { status: "RELEASED", releasedAt: new Date("2026-08-13T00:00:00Z") },
		});
	});
});
