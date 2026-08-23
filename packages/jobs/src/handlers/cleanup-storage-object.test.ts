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

	it("deletes a completed multipart staging object before releasing its reservation", async () => {
		const abortMultipartUpload = vi.fn(async () => {
			throw Object.assign(new Error("gone"), { name: "NoSuchUpload" });
		});
		const isComplete = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const complete = vi.fn(async () => undefined);
		const dependencies = {
			isComplete,
			deleteObject: vi.fn(async () => undefined),
			abortMultipartUpload,
			complete,
		};

		const payload = {
			assetId: "asset-1",
			objectKey: "key",
			cleanupObjectKeys: ["final-key"],
			multipartUploadId: "upload-1",
			uploadSessionId: "session-1",
			reservationStatus: "RELEASED" as const,
		};
		await abortMultipartObject(payload, dependencies);
		await abortMultipartObject(payload, dependencies);

		expect(abortMultipartUpload).toHaveBeenCalledOnce();
		expect(dependencies.deleteObject).toHaveBeenCalledTimes(2);
		expect(dependencies.deleteObject).toHaveBeenNthCalledWith(1, "key");
		expect(dependencies.deleteObject).toHaveBeenNthCalledWith(2, "final-key");
		expect(complete).toHaveBeenCalledWith(
			expect.objectContaining({
				uploadSessionId: "session-1",
				reservationStatus: "RELEASED",
				cleanupObjectKeys: ["final-key"],
			}),
		);
		expect(complete).toHaveBeenCalledOnce();
	});

	it("does not release its reservation if deleting a completed multipart staging object fails", async () => {
		const complete = vi.fn(async () => undefined);
		const dependencies = {
			isComplete: vi.fn(async () => false),
			abortMultipartUpload: vi.fn(async () => {
				throw Object.assign(new Error("gone"), { name: "NoSuchUpload" });
			}),
			deleteObject: vi.fn(async () => {
				throw new Error("storage delete unavailable");
			}),
			complete,
		};

		await expect(
			abortMultipartObject(
				{
					assetId: "asset-1",
					objectKey: "staging-key",
					multipartUploadId: "upload-1",
					uploadSessionId: "session-1",
					reservationStatus: "RELEASED",
				},
				dependencies,
			),
		).rejects.toThrow(/delete unavailable/i);
		expect(complete).not.toHaveBeenCalled();
	});
});
