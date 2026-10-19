import { describe, expect, it, vi } from "vitest";

import {
	abortMultipartObject,
	abortPromotionMultipart,
	cleanupUploadPromotion,
	deleteStorageObject,
} from "./cleanup-storage-object";

describe("storage cleanup handlers", () => {
	it("fails closed before storage I/O when the mandatory ownership fence is missing", async () => {
		const dependencies = {
			isComplete: vi.fn(async () => false),
			deleteObject: vi.fn(async () => undefined),
			complete: vi.fn(async () => undefined),
		};
		await expect(
			deleteStorageObject({ assetId: "asset", objectKey: "final" }, dependencies as never),
		).rejects.toThrow();
		expect(dependencies.isComplete).not.toHaveBeenCalled();
		expect(dependencies.deleteObject).not.toHaveBeenCalled();
		expect(dependencies.complete).not.toHaveBeenCalled();
	});
	it("does not reuse primary-key-only or different cleanup-group receipts", async () => {
		const receipts = new Set<string>();
		const dependencies = {
			claimDeletion: vi.fn(async () => "DELETE" as const),
			isComplete: vi.fn(
				async (key: string) => receipts.has(key) || /^media-object-delete:asset:/.test(key),
			),
			deleteObject: vi.fn(async () => undefined),
			abortMultipartUpload: vi.fn(async () => undefined),
			complete: vi.fn(async ({ operationKey }: { operationKey: string }) => {
				receipts.add(operationKey);
			}),
		};
		await deleteStorageObject({ assetId: "asset", objectKey: "final" }, dependencies);
		await deleteStorageObject(
			{ assetId: "asset", objectKey: "final", cleanupObjectKeys: ["stage"] },
			dependencies,
		);
		const releasingPayload = {
			assetId: "asset",
			objectKey: "final",
			cleanupObjectKeys: ["stage"],
			uploadSessionId: "session",
			reservationStatus: "RELEASED" as const,
		};
		await deleteStorageObject(releasingPayload, dependencies);
		await deleteStorageObject(releasingPayload, dependencies);
		expect(dependencies.complete).toHaveBeenCalledTimes(3);
		expect(dependencies.deleteObject).toHaveBeenCalledTimes(5);
		expect(receipts.size).toBe(3);
	});
	it.each(["delete", "multipart", "promotion"] as const)(
		"does not delete, abort, acknowledge, or release a skipped %s cleanup",
		async (kind) => {
			const dependencies = {
				claimDeletion: vi.fn(async () => "SKIP" as const),
				isComplete: vi.fn(async () => false),
				deleteObject: vi.fn(async () => undefined),
				abortMultipartUpload: vi.fn(async () => undefined),
				listMultipartUploads: vi.fn(async () => []),
				complete: vi.fn(async () => undefined),
			};
			const payload = {
				assetId: "promoted-input",
				objectKey: "staging-key",
				cleanupObjectKeys: ["account-final-key"],
				uploadSessionId: "session",
				reservationStatus: "RELEASED" as const,
			};
			if (kind === "delete") await deleteStorageObject(payload, dependencies);
			else if (kind === "multipart")
				await abortMultipartObject({ ...payload, multipartUploadId: "upload" }, dependencies);
			else
				await cleanupUploadPromotion(
					{ ...payload, promotionObjectKey: "account-final-key" },
					dependencies,
				);
			expect(dependencies.claimDeletion).toHaveBeenCalledWith({
				assetId: "promoted-input",
				objectKeys: ["staging-key", "account-final-key"],
				uploadSessionId: "session",
				releasesReservation: true,
			});
			expect(dependencies.deleteObject).not.toHaveBeenCalled();
			expect(dependencies.abortMultipartUpload).not.toHaveBeenCalled();
			expect(dependencies.isComplete).not.toHaveBeenCalled();
			expect(dependencies.complete).not.toHaveBeenCalled();
		},
	);

	it("retries guest final and clean-staging deletion and completes duplicate delivery only once", async () => {
		let completed = false;
		let failCleanStaging = true;
		const deleteObject = vi.fn(async (objectKey: string) => {
			if (objectKey.endsWith("clean.png") && failCleanStaging) {
				throw new Error("guest clean staging delete unavailable");
			}
		});
		const complete = vi.fn(async () => {
			completed = true;
		});
		const dependencies = {
			claimDeletion: vi.fn(async () => "DELETE" as const),
			isComplete: vi.fn(async () => completed),
			deleteObject,
			abortMultipartUpload: vi.fn(async () => undefined),
			complete,
		};
		const payload = {
			assetId: "guest-output",
			objectKey: "users/guest/assets/guest-output/watermarked.png",
			cleanupObjectKeys: ["users/guest/staging/guest-output/clean.png"],
		};

		await expect(deleteStorageObject(payload, dependencies)).rejects.toThrow(
			/clean staging delete unavailable/i,
		);
		expect(complete).not.toHaveBeenCalled();
		failCleanStaging = false;
		await deleteStorageObject(payload, dependencies);
		await deleteStorageObject(payload, dependencies);

		expect(deleteObject).toHaveBeenCalledTimes(4);
		expect(deleteObject).toHaveBeenNthCalledWith(
			1,
			"users/guest/assets/guest-output/watermarked.png",
		);
		expect(deleteObject).toHaveBeenNthCalledWith(2, "users/guest/staging/guest-output/clean.png");
		expect(complete).toHaveBeenCalledOnce();
	});

	it("deletes a soft-deleted object once and records cleanup completion idempotently", async () => {
		const deleteObject = vi.fn(async () => undefined);
		const isComplete = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const complete = vi.fn(async () => undefined);
		const dependencies = {
			claimDeletion: vi.fn(async () => "DELETE" as const),
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
			claimDeletion: vi.fn(async () => "DELETE" as const),
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
			claimDeletion: vi.fn(async () => "DELETE" as const),
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

	it("aborts known and zero-part final multipart uploads before deleting a terminal upload", async () => {
		const sequence: string[] = [];
		const dependencies = {
			claimDeletion: vi.fn(async () => "DELETE" as const),
			isComplete: vi.fn(async () => false),
			abortMultipartUpload: vi.fn(async (objectKey: string, uploadId: string) => {
				sequence.push(`abort:${objectKey}:${uploadId}`);
			}),
			listMultipartUploads: vi.fn(async (objectKey: string) => {
				sequence.push(`list:${objectKey}`);
				return ["zero-part-orphan"];
			}),
			deleteObject: vi.fn(async (objectKey: string) => {
				sequence.push(`delete:${objectKey}`);
			}),
			complete: vi.fn(async () => {
				sequence.push("complete");
			}),
		};

		await cleanupUploadPromotion(
			{
				assetId: "asset-1",
				objectKey: "staging-key",
				multipartUploadId: "staging-upload",
				promotionObjectKey: "final-key",
				promotionMultipartUploadId: "known-final-upload",
				cleanupObjectKeys: ["final-key"],
				uploadSessionId: "session-1",
				reservationStatus: "RELEASED",
			},
			dependencies,
		);

		expect(sequence).toEqual([
			"abort:staging-key:staging-upload",
			"abort:final-key:known-final-upload",
			"list:final-key",
			"abort:final-key:zero-part-orphan",
			"delete:staging-key",
			"delete:final-key",
			"complete",
		]);
		expect(dependencies.complete).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "MEDIA_UPLOAD_PROMOTION_CLEANUP_COMPLETED",
				uploadSessionId: "session-1",
				reservationStatus: "RELEASED",
			}),
		);
	});

	it("aborts an expired lease's final multipart upload without deleting its final object", async () => {
		const dependencies = {
			claimDeletion: vi.fn(async () => "DELETE" as const),
			isComplete: vi.fn(async () => false),
			abortMultipartUpload: vi.fn(async () => undefined),
			listMultipartUploads: vi.fn(async () => []),
			deleteObject: vi.fn(async () => undefined),
			complete: vi.fn(async () => undefined),
		};

		await abortPromotionMultipart(
			{ assetId: "asset-1", objectKey: "final-key", multipartUploadId: "final-upload" },
			dependencies,
		);

		expect(dependencies.abortMultipartUpload).toHaveBeenCalledWith("final-key", "final-upload");
		expect(dependencies.deleteObject).not.toHaveBeenCalled();
		expect(dependencies.complete).toHaveBeenCalledWith(
			expect.objectContaining({ action: "MEDIA_PROMOTION_MULTIPART_ABORT_COMPLETED" }),
		);
	});
});
