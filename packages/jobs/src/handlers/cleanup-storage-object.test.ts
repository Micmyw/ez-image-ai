import { describe, expect, it, vi } from "vitest";

import { abortMultipartObject, deleteStorageObject } from "./cleanup-storage-object";

describe("storage cleanup handlers", () => {
	it("deletes a soft-deleted object once and records cleanup completion idempotently", async () => {
		const deleteObject = vi.fn(async () => undefined);
		const isComplete = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const complete = vi.fn(async () => undefined);
		const dependencies = {
			isComplete,
			deleteObject,
			abortMultipartUpload: vi.fn(),
			complete,
		};

		await deleteStorageObject({ assetId: "asset-1", objectKey: "key" }, dependencies);
		await deleteStorageObject({ assetId: "asset-1", objectKey: "key" }, dependencies);

		expect(deleteObject).toHaveBeenCalledOnce();
		expect(complete).toHaveBeenCalledOnce();
	});

	it("treats NoSuchUpload as success and does not abort the same multipart upload twice", async () => {
		const abortMultipartUpload = vi.fn(async () => {
			throw Object.assign(new Error("gone"), { name: "NoSuchUpload" });
		});
		const isComplete = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const complete = vi.fn(async () => undefined);
		const dependencies = {
			isComplete,
			deleteObject: vi.fn(),
			abortMultipartUpload,
			complete,
		};

		const payload = {
			assetId: "asset-1",
			objectKey: "key",
			multipartUploadId: "upload-1",
		};
		await abortMultipartObject(payload, dependencies);
		await abortMultipartObject(payload, dependencies);

		expect(abortMultipartUpload).toHaveBeenCalledOnce();
		expect(complete).toHaveBeenCalledOnce();
	});
});
