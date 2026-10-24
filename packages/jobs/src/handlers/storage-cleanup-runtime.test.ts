import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import { createDatabaseStorageCleanupDependencies } from "../runtime";
import { cleanupUploadPromotion, deleteStorageObject } from "./cleanup-storage-object";

// These accounting cases use an orphan asset; the ownership fence has separate
// retained-account coverage below and in the database claim unit/race suites.
const orphanAssetFence = {
	$executeRaw: vi.fn(async () => 1),
	mediaAsset: { findUnique: vi.fn(async () => null) },
};

describe("production storage cleanup store", () => {
	afterEach(() => vi.unstubAllEnvs());
	it.each(["final", "stage"])(
		"retains an automatic tombstone's original and quota when cleaning %s",
		async (objectKey) => {
			vi.stubEnv("MEDIA_IMAGE_AUTO_DELETE_ENABLED", undefined);
			const tx = {
				$executeRaw: vi.fn(async () => 1),
				mediaAsset: {
					findUnique: vi.fn(async () => ({
						id: "asset",
						ownerId: "owner",
						mimeType: "image/png",
						verificationEngine: "legacy",
						objectKey: "final",
						status: "DELETED",
						deletedAt: new Date(),
						uploadSessions: [],
					})),
				},
				auditLog: { findFirst: vi.fn(async () => null), create: vi.fn() },
				storageUsageReservation: { updateMany: vi.fn() },
			};
			const storage = {
				deleteObject: vi.fn(async () => undefined),
				abortMultipartUpload: vi.fn(async () => undefined),
			};
			const dependencies = createDatabaseStorageCleanupDependencies(
				{ $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx) } as never,
				storage,
			);
			await expect(
				deleteStorageObject(
					{
						assetId: "asset",
						objectKey,
						storageReservationReferenceKey: "temporary-reference:asset",
					},
					dependencies,
				),
			).rejects.toThrow("MEDIA_IMAGE_AUTOMATIC_DELETION_PAUSED");
			if (objectKey === "stage")
				expect(storage.deleteObject).toHaveBeenCalledExactlyOnceWith("stage");
			else expect(storage.deleteObject).not.toHaveBeenCalled();
			expect(tx.auditLog.create).not.toHaveBeenCalled();
			expect(tx.storageUsageReservation.updateMany).not.toHaveBeenCalled();
		},
	);
	it("wires the ownership fence before receipts and leaves a retained account object and reservation alone", async () => {
		const create = vi.fn();
		const updateMany = vi.fn();
		const findFirst = vi.fn(async () => null);
		const tx = {
			$executeRaw: vi.fn(async () => 1),
			$queryRaw: vi.fn(async () => [{ now: new Date() }]),
			mediaAsset: {
				findUnique: vi.fn(async () => ({
					id: "retained",
					objectKey: "final",
					status: "READY",
					deletedAt: null,
					retentionClass: "ACCOUNT",
					deleteAfter: null,
				})),
			},
			generationDraft: { findFirst: vi.fn(async () => null) },
			auditLog: { create },
			storageUsageReservation: { updateMany },
		};
		const storage = {
			deleteObject: vi.fn(async () => undefined),
			abortMultipartUpload: vi.fn(async () => undefined),
		};
		const dependencies = createDatabaseStorageCleanupDependencies(
			{
				auditLog: { findFirst },
				$transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(tx)),
			} as never,
			storage,
		);
		await deleteStorageObject(
			{
				assetId: "retained",
				objectKey: "stage",
				cleanupObjectKeys: ["final"],
				storageReservationReferenceKey: "media-draft:retained",
			},
			dependencies,
		);
		expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
		expect(findFirst).not.toHaveBeenCalled();
		expect(storage.deleteObject).not.toHaveBeenCalled();
		expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
	});
	it("releases guest storage only after final, staging, and multipart cleanup survives a retry", async () => {
		let cleanupRecorded = false;
		let reservationStatus: "COMMITTED" | "RELEASED" = "COMMITTED";
		let finalDeleteFails = true;
		const findFirst = vi.fn(async () => (cleanupRecorded ? { id: "guest-cleanup-audit" } : null));
		const create = vi.fn(async () => {
			cleanupRecorded = true;
			return { id: "guest-cleanup-audit" };
		});
		const updateMany = vi.fn(async ({ where, data }) => {
			if (
				where.referenceKey !== "media-upload:guest-session" ||
				!where.status.in.includes(reservationStatus)
			) {
				return { count: 0 };
			}
			reservationStatus = data.status;
			return { count: 1 };
		});
		const $transaction = vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
			operation({
				...orphanAssetFence,
				auditLog: { create },
				storageUsageReservation: { updateMany },
			}),
		);
		const deleteObject = vi.fn(async (objectKey: string) => {
			if (objectKey.endsWith("watermarked.png") && finalDeleteFails) {
				throw new Error("guest final delete unavailable");
			}
		});
		const abortMultipartUpload = vi.fn(async () => undefined);
		const listMultipartUploads = vi.fn(async () => ["guest-orphan-upload"]);
		const dependencies = createDatabaseStorageCleanupDependencies(
			{ auditLog: { findFirst }, $transaction } as never,
			{ deleteObject, abortMultipartUpload, listMultipartUploads },
		);
		const payload = {
			assetId: "guest-output",
			objectKey: "users/guest/staging/guest-output/clean.png",
			multipartUploadId: "guest-staging-upload",
			promotionObjectKey: "users/guest/assets/guest-output/watermarked.png",
			promotionMultipartUploadId: "guest-final-upload",
			cleanupObjectKeys: ["users/guest/assets/guest-output/watermarked.png"],
			uploadSessionId: "guest-session",
			reservationStatus: "RELEASED" as const,
		};

		await expect(cleanupUploadPromotion(payload, dependencies)).rejects.toThrow(
			/guest final delete unavailable/i,
		);
		expect(reservationStatus).toBe("COMMITTED");
		expect(create).not.toHaveBeenCalled();

		finalDeleteFails = false;
		await cleanupUploadPromotion(payload, dependencies);
		await cleanupUploadPromotion(payload, dependencies);

		expect(reservationStatus).toBe("RELEASED");
		expect(create).toHaveBeenCalledOnce();
		expect(abortMultipartUpload).toHaveBeenCalledWith(
			"users/guest/staging/guest-output/clean.png",
			"guest-staging-upload",
		);
		expect(abortMultipartUpload).toHaveBeenCalledWith(
			"users/guest/assets/guest-output/watermarked.png",
			"guest-final-upload",
		);
		expect(abortMultipartUpload).toHaveBeenCalledWith(
			"users/guest/assets/guest-output/watermarked.png",
			"guest-orphan-upload",
		);
		expect(deleteObject).toHaveBeenCalledWith("users/guest/staging/guest-output/clean.png");
		expect(deleteObject).toHaveBeenCalledWith("users/guest/assets/guest-output/watermarked.png");
	});

	it("retains a committed reservation when deletion fails and releases it only after a successful retry", async () => {
		let cleanupRecorded = false;
		let reservationStatus: "COMMITTED" | "RELEASED" = "COMMITTED";
		let deleteFails = true;
		const findFirst = vi.fn(async () => (cleanupRecorded ? { id: "audit-1" } : null));
		const create = vi.fn(async () => {
			cleanupRecorded = true;
			return { id: "audit-1" };
		});
		const updateMany = vi.fn(async ({ where, data }) => {
			const expectedStatuses = Array.isArray(where.status?.in) ? where.status.in : [where.status];
			if (!expectedStatuses.includes(reservationStatus)) return { count: 0 };
			reservationStatus = data.status;
			return { count: 1 };
		});
		const $transaction = vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
			operation({
				...orphanAssetFence,
				auditLog: { create },
				storageUsageReservation: { updateMany },
			}),
		);
		const deleteObject = vi.fn(async () => {
			if (deleteFails) throw new Error("object store unavailable");
		});
		const dependencies = createDatabaseStorageCleanupDependencies(
			{ auditLog: { findFirst }, $transaction } as never,
			{ deleteObject, abortMultipartUpload: vi.fn() },
		);

		const payload = {
			assetId: "asset-1",
			objectKey: "users/u/assets/asset-1/original.png",
			cleanupObjectKeys: ["users/u/staging/session-1/nonce.png"],
			uploadSessionId: "session-1",
			reservationStatus: "RELEASED" as const,
		};
		await expect(deleteStorageObject(payload, dependencies)).rejects.toThrow(/unavailable/i);
		expect(reservationStatus).toBe("COMMITTED");
		expect(create).not.toHaveBeenCalled();

		deleteFails = false;
		await deleteStorageObject(payload, dependencies);
		expect(reservationStatus).toBe("RELEASED");

		expect(deleteObject).toHaveBeenCalledTimes(3);
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				action: "MEDIA_OBJECT_DELETE_COMPLETED",
				targetType: "MEDIA_STORAGE_OPERATION",
				targetId: expect.stringMatching(/^media-object-delete:v2:asset-1:/),
			}),
		});
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				referenceKey: "media-upload:session-1",
				status: { in: ["ACTIVE", "COMMITTED"] },
			},
			data: { status: "RELEASED", releasedAt: expect.any(Date) },
		});
	});

	it.each(["generation-output", "media-draft", "temporary-reference"])(
		"releases a %s reservation only after its immutable object is deleted",
		async (referencePrefix) => {
			let cleanupRecorded = false;
			let reservationStatus: "COMMITTED" | "RELEASED" = "COMMITTED";
			let deleteFails = true;
			const findFirst = vi.fn(async () => (cleanupRecorded ? { id: "audit-output" } : null));
			const create = vi.fn(async () => {
				cleanupRecorded = true;
				return { id: "audit-output" };
			});
			const updateMany = vi.fn(async ({ where, data }) => {
				if (
					where.referenceKey !== `${referencePrefix}:asset-output` ||
					!where.status.in.includes(reservationStatus)
				) {
					return { count: 0 };
				}
				reservationStatus = data.status;
				return { count: 1 };
			});
			const $transaction = vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
				operation({
					...orphanAssetFence,
					auditLog: { create },
					storageUsageReservation: { updateMany },
				}),
			);
			const deleteObject = vi.fn(async () => {
				if (deleteFails) throw new Error("object store unavailable");
			});
			const dependencies = createDatabaseStorageCleanupDependencies(
				{ auditLog: { findFirst }, $transaction } as never,
				{ deleteObject, abortMultipartUpload: vi.fn() },
			);
			const payload = {
				assetId: "asset-output",
				objectKey: "users/u/assets/asset-output/original.png",
				storageReservationReferenceKey: `${referencePrefix}:asset-output`,
			};

			await expect(deleteStorageObject(payload, dependencies)).rejects.toThrow(/unavailable/i);
			expect(reservationStatus).toBe("COMMITTED");
			expect(create).not.toHaveBeenCalled();

			deleteFails = false;
			await deleteStorageObject(payload, dependencies);
			expect(reservationStatus).toBe("RELEASED");
			expect(updateMany).toHaveBeenCalledWith({
				where: {
					referenceKey: `${referencePrefix}:asset-output`,
					status: { in: ["ACTIVE", "COMMITTED"] },
				},
				data: { status: "RELEASED", releasedAt: expect.any(Date) },
			});
		},
	);
});
