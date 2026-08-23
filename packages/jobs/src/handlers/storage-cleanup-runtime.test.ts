import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import { createDatabaseStorageCleanupDependencies } from "../runtime";
import { deleteStorageObject } from "./cleanup-storage-object";

describe("production storage cleanup store", () => {
	it("physically deletes once, records an audit completion, and skips replay", async () => {
		const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "audit-1" });
		const create = vi.fn(async () => ({ id: "audit-1" }));
		const updateMany = vi.fn(async () => ({ count: 1 }));
		const $transaction = vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
			operation({ auditLog: { create }, storageUsageReservation: { updateMany } }),
		);
		const deleteObject = vi.fn(async () => undefined);
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
		await deleteStorageObject(payload, dependencies);
		await deleteStorageObject(payload, dependencies);

		expect(deleteObject).toHaveBeenCalledTimes(2);
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				action: "MEDIA_OBJECT_DELETE_COMPLETED",
				targetType: "MEDIA_STORAGE_OPERATION",
				targetId: expect.stringMatching(/^media-object-delete:asset-1:/),
			}),
		});
		expect(updateMany).toHaveBeenCalledWith({
			where: { referenceKey: "media-upload:session-1", status: "ACTIVE" },
			data: { status: "RELEASED", releasedAt: expect.any(Date) },
		});
	});
});
