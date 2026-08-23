import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import { createDatabaseStorageCleanupDependencies } from "../runtime";
import { deleteStorageObject } from "./cleanup-storage-object";

describe("production storage cleanup store", () => {
	it("physically deletes once, records an audit completion, and skips replay", async () => {
		const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "audit-1" });
		const create = vi.fn(async () => ({ id: "audit-1" }));
		const deleteObject = vi.fn(async () => undefined);
		const dependencies = createDatabaseStorageCleanupDependencies(
			{ auditLog: { findFirst, create } } as never,
			{ deleteObject, abortMultipartUpload: vi.fn() },
		);

		const payload = { assetId: "asset-1", objectKey: "users/u/assets/asset-1/original.png" };
		await deleteStorageObject(payload, dependencies);
		await deleteStorageObject(payload, dependencies);

		expect(deleteObject).toHaveBeenCalledOnce();
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				action: "MEDIA_OBJECT_DELETE_COMPLETED",
				targetType: "MEDIA_STORAGE_OPERATION",
				targetId: "media-object-delete:asset-1",
			}),
		});
	});
});
