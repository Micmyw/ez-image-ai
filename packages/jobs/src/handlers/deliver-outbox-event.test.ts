import { describe, expect, it, vi } from "vitest";

import { deleteStorageObject } from "./cleanup-storage-object";
import { deliverOutboxEvent } from "./deliver-outbox-event";
import { dispatchOutbox } from "./dispatch-outbox";

describe("outbox delivery routes", () => {
	it("routes guest eligibility through the durable admission worker and waits for its result", async () => {
		const trigger = vi.fn(async () => undefined);
		const triggerAndWait = vi.fn(async () => undefined);
		await deliverOutboxEvent(
			{
				id: "guest-event-1",
				eventType: "GUEST_GENERATION_ELIGIBLE",
				aggregateId: "guest-job-1",
				payload: { jobId: "guest-job-1", trialId: "guest-trial-1" },
				leaseToken: "guest-lease-1",
				attempts: 1,
			},
			{ trigger, triggerAndWait, resolveDispatchRoute: vi.fn() },
		);

		expect(triggerAndWait).toHaveBeenCalledWith("media-admit-guest-generation", {
			jobId: "guest-job-1",
			trialId: "guest-trial-1",
		});
		expect(trigger).not.toHaveBeenCalled();
	});

	it.each(["JOB_CREATED", "GENERATION_DISPATCH"])(
		"does not trigger %s when its dispatch route is unavailable",
		async (eventType) => {
			const trigger = vi.fn(async () => undefined);
			const resolveDispatchRoute = vi.fn(async () => null);
			await deliverOutboxEvent(
				{
					id: "event-1",
					eventType,
					aggregateId: "job-1",
					payload: { version: 3 },
					leaseToken: "lease-1",
					attempts: 1,
				},
				{ trigger, resolveDispatchRoute },
			);
			expect(resolveDispatchRoute).toHaveBeenCalledOnce();
			expect(resolveDispatchRoute).toHaveBeenCalledWith("job-1");
			expect(trigger).not.toHaveBeenCalled();
		},
	);

	it("pins the resolved provider route into every generation dispatch payload", async () => {
		const trigger = vi.fn(async () => undefined);
		await deliverOutboxEvent(
			{
				id: "event-pinned-route",
				eventType: "JOB_CREATED",
				aggregateId: "job-1",
				payload: { version: 3 },
				leaseToken: "lease-1",
				attempts: 1,
			},
			{
				trigger,
				resolveDispatchRoute: async () => ({
					taskId: "media-dispatch-image-replicate-black-forest-labs_flux-schnell",
					provider: "replicate" as const,
					providerModelId: "black-forest-labs/flux-schnell",
				}),
			},
		);

		expect(trigger).toHaveBeenCalledWith(
			"media-dispatch-image-replicate-black-forest-labs_flux-schnell",
			{
				jobId: "job-1",
				version: 3,
				provider: "replicate",
				providerModelId: "black-forest-labs/flux-schnell",
			},
		);
	});

	it("routes an accepted-job cancellation request to the cancellation worker, not settlement", async () => {
		const triggerAndWait = vi.fn(async () => undefined);
		await deliverOutboxEvent(
			{
				id: "event-cancel-request",
				eventType: "GENERATION_CANCEL_REQUESTED",
				aggregateId: "job-1",
				payload: { version: 5 },
				leaseToken: "lease-1",
				attempts: 1,
			},
			{ trigger: vi.fn(), triggerAndWait, resolveDispatchRoute: vi.fn() },
		);

		expect(triggerAndWait).toHaveBeenCalledWith("media-cancel-generation", {
			jobId: "job-1",
			version: 5,
		});
	});

	it("keeps a failed provider cancellation intent retryable in the outbox", async () => {
		const event = {
			id: "event-cancel-retry",
			eventType: "GENERATION_CANCEL_REQUESTED",
			aggregateId: "job-1",
			payload: { version: 5 },
			leaseToken: "lease-cancel-retry",
			attempts: 1,
		};
		const store = {
			claimBatch: vi.fn(async () => [event]),
			complete: vi.fn(async () => undefined),
			release: vi.fn(async () => undefined),
		};

		await dispatchOutbox(
			{ workerId: "worker-1" },
			{
				store,
				deliver: (leasedEvent) =>
					deliverOutboxEvent(leasedEvent, {
						trigger: vi.fn(),
						triggerAndWait: async () => {
							throw new Error("cancellation temporarily unavailable");
						},
						resolveDispatchRoute: vi.fn(),
					}),
			},
		);

		expect(store.complete).not.toHaveBeenCalled();
		expect(store.release).toHaveBeenCalledWith(
			expect.objectContaining({
				id: event.id,
				leaseToken: event.leaseToken,
				errorCode: "DELIVERY_FAILED",
			}),
		);
	});

	it.each(["MEDIA_ASSET_VERIFY", "MEDIA_ASSET_MODERATION_REQUESTED"])(
		"never silently completes %s",
		async (eventType) => {
			const trigger = vi.fn(async () => undefined);
			await deliverOutboxEvent(
				{
					id: "event-1",
					eventType,
					aggregateId: "asset-1",
					payload: { assetId: "asset-1" },
					leaseToken: "lease-1",
					attempts: 1,
				},
				{ trigger, resolveDispatchRoute: vi.fn() },
			);
			expect(trigger).toHaveBeenCalledWith("media-verify-upload", { assetId: "asset-1" });
		},
	);

	it.each([
		[
			"MEDIA_OBJECT_DELETE",
			"media-delete-object",
			{ assetId: "asset-1", objectKey: "key", cleanupObjectKeys: ["final-key"] },
		],
		[
			"MEDIA_MULTIPART_ABORT",
			"media-abort-multipart",
			{
				assetId: "asset-1",
				objectKey: "key",
				multipartUploadId: "upload-1",
				cleanupObjectKeys: ["final-key"],
			},
		],
		[
			"MEDIA_UPLOAD_CLEANUP",
			"media-delete-object",
			{
				assetId: "asset-1",
				objectKey: "key",
				cleanupObjectKeys: ["final-key"],
				uploadSessionId: "session-1",
				reservationStatus: "RELEASED",
			},
		],
		[
			"MEDIA_UPLOAD_CLEANUP",
			"media-abort-multipart",
			{
				assetId: "asset-1",
				objectKey: "key",
				multipartUploadId: "upload-1",
				cleanupObjectKeys: ["final-key"],
				uploadSessionId: "session-1",
				reservationStatus: "RELEASED",
			},
		],
		[
			"MEDIA_UPLOAD_CLEANUP",
			"media-cleanup-upload-promotion",
			{
				assetId: "asset-1",
				objectKey: "staging-key",
				multipartUploadId: "staging-upload",
				promotionObjectKey: "final-key",
				promotionMultipartUploadId: "final-upload",
				cleanupObjectKeys: ["final-key"],
				uploadSessionId: "session-1",
				reservationStatus: "RELEASED",
			},
		],
		[
			"MEDIA_UPLOAD_CLEANUP",
			"media-abort-promotion-multipart",
			{
				assetId: "asset-1",
				objectKey: "final-key",
				multipartUploadId: "final-upload",
				promotionAbortOnly: true,
			},
		],
	])("routes %s to its real cleanup task", async (eventType, taskId, payload) => {
		const triggerAndWait = vi.fn(async () => undefined);
		await deliverOutboxEvent(
			{
				id: "event-1",
				eventType,
				aggregateId: "asset-1",
				payload,
				leaseToken: "lease-1",
				attempts: 1,
			},
			{ trigger: vi.fn(), triggerAndWait, resolveDispatchRoute: vi.fn() },
		);
		expect(triggerAndWait).toHaveBeenCalledWith(taskId, payload);
	});

	it("routes the fenced legacy re-verification event with explicit authorization", async () => {
		const trigger = vi.fn(async () => undefined);
		await deliverOutboxEvent(
			{
				id: "event-legacy-reverify",
				eventType: "MEDIA_ASSET_LEGACY_REVERIFY",
				aggregateId: "asset-1",
				payload: { assetId: "asset-1" },
				leaseToken: "lease-1",
				attempts: 1,
			},
			{ trigger, resolveDispatchRoute: vi.fn() },
		);
		expect(trigger).toHaveBeenCalledWith("media-verify-upload", {
			assetId: "asset-1",
			allowQuarantinedReverification: true,
		});
	});

	it("completes a soft-delete outbox event after storage cleanup and keeps replay safe", async () => {
		const sequence: string[] = [];
		let cleanupComplete = false;
		const deleteObject = vi.fn(async () => {
			sequence.push("storage-delete");
		});
		const event = {
			id: "event-1",
			eventType: "MEDIA_OBJECT_DELETE",
			aggregateId: "asset-1",
			payload: { assetId: "asset-1", objectKey: "users/u/assets/asset-1/original.png" },
			leaseToken: "lease-1",
			attempts: 1,
		};
		const store = {
			claimBatch: vi.fn(async () => [event]),
			complete: vi.fn(async () => {
				sequence.push("outbox-complete");
			}),
			release: vi.fn(async () => undefined),
		};
		const deliver = (leasedEvent: typeof event) =>
			deliverOutboxEvent(leasedEvent, {
				trigger: vi.fn(),
				resolveDispatchRoute: vi.fn(),
				triggerAndWait: async (taskId, payload) => {
					if (taskId !== "media-delete-object") throw new Error("Unexpected cleanup task");
					await deleteStorageObject(payload as { assetId: string; objectKey: string }, {
						isComplete: async () => cleanupComplete,
						deleteObject,
						abortMultipartUpload: vi.fn(),
						complete: async () => {
							cleanupComplete = true;
							sequence.push("cleanup-complete");
						},
					});
				},
			});

		await dispatchOutbox({ workerId: "worker-1" }, { store, deliver });
		expect(sequence).toEqual(["storage-delete", "cleanup-complete", "outbox-complete"]);

		await dispatchOutbox({ workerId: "worker-1" }, { store, deliver });
		expect(deleteObject).toHaveBeenCalledOnce();
		expect(sequence).toEqual([
			"storage-delete",
			"cleanup-complete",
			"outbox-complete",
			"outbox-complete",
		]);
	});

	it("forwards the exact generated-output reservation reference to deletion cleanup", async () => {
		const triggerAndWait = vi.fn(async () => undefined);
		await deliverOutboxEvent(
			{
				id: "event-generated-output-delete",
				eventType: "MEDIA_OBJECT_DELETE",
				aggregateId: "asset-output",
				payload: {
					assetId: "asset-output",
					objectKey: "users/u/assets/asset-output/original.png",
					storageReservationReferenceKey: "generation-output:asset-output",
				},
				leaseToken: "lease-generated-output-delete",
				attempts: 1,
			},
			{ trigger: vi.fn(), triggerAndWait, resolveDispatchRoute: vi.fn() },
		);

		expect(triggerAndWait).toHaveBeenCalledWith("media-delete-object", {
			assetId: "asset-output",
			objectKey: "users/u/assets/asset-output/original.png",
			storageReservationReferenceKey: "generation-output:asset-output",
		});
	});

	it("releases cleanup delivery for retry when storage or cleanup completion fails", async () => {
		const event = {
			id: "event-cleanup-failure",
			eventType: "MEDIA_OBJECT_DELETE",
			aggregateId: "asset-1",
			payload: { assetId: "asset-1", objectKey: "users/u/assets/asset-1/original.png" },
			leaseToken: "lease-cleanup-failure",
			attempts: 2,
		};
		const store = {
			claimBatch: vi.fn(async () => [event]),
			complete: vi.fn(async () => undefined),
			release: vi.fn(async () => undefined),
		};
		await dispatchOutbox(
			{ workerId: "worker-1" },
			{
				store,
				deliver: (leasedEvent) =>
					deliverOutboxEvent(leasedEvent, {
						trigger: vi.fn(),
						resolveDispatchRoute: vi.fn(),
						triggerAndWait: async () => {
							throw new Error("storage cleanup failed");
						},
					}),
			},
		);
		expect(store.complete).not.toHaveBeenCalled();
		expect(store.release).toHaveBeenCalledWith(
			expect.objectContaining({
				id: event.id,
				leaseToken: event.leaseToken,
				errorCode: "DELIVERY_FAILED",
			}),
		);
	});
});
