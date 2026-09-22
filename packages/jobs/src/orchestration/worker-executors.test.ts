import { STATIC_DISPATCH_ROUTE_MANIFEST } from "@repo/ai/media/catalog/dispatch-manifest";
import { describe, expect, it } from "vitest";

import type { TaskRequest } from "./contracts";
import {
	assertWorkerInlineTask,
	workerExecutorForTask,
	workerExecutorLane,
} from "./worker-executors";

describe("Worker executor workload boundaries", () => {
	it("keeps synchronous image responses serialized and asynchronous submissions on control", () => {
		for (const route of STATIC_DISPATCH_ROUTE_MANIFEST) {
			const task = { taskId: route.taskId, payload: { jobId: "job", version: 0 } };
			const heavy = route.provider === "gemini" || route.provider === "openrouter";
			expect(workerExecutorForTask(task)).toEqual(
				heavy ? { name: "jobs-primary", maxActive: 1 } : { name: "jobs-control", maxActive: 4 },
			);
		}
	});
	it("preserves the heavy transfer identity and fences explicit legacy reinspection", () => {
		expect(
			workerExecutorForTask({
				taskId: "media-finalize-generation",
				payload: { jobId: "job", version: 0 },
			}),
		).toEqual({ name: "jobs-primary", maxActive: 1 });
		expect(
			workerExecutorLane({ taskId: "media-verify-upload", payload: { assetId: "asset" } }),
		).toBe("control");
		expect(
			workerExecutorLane({
				taskId: "media-verify-upload",
				payload: { assetId: "asset", allowQuarantinedReverification: true },
			}),
		).toBe("heavy");
	});
	it("retains the maintenance slot for inline children and rejects cross-executor work", () => {
		const parent: TaskRequest = { taskId: "media-deliver-outbox", payload: {} };
		const children: TaskRequest[] = [
			{ taskId: "media-delete-object", payload: { assetId: "asset", objectKey: "private/key" } },
			{
				taskId: "media-abort-multipart",
				payload: { assetId: "asset", objectKey: "private/key", multipartUploadId: "upload" },
			},
			{
				taskId: "media-cleanup-upload-promotion",
				payload: {
					assetId: "asset",
					objectKey: "private/key",
					promotionObjectKey: "private/promotion",
				},
			},
			{
				taskId: "media-abort-promotion-multipart",
				payload: {
					assetId: "asset",
					objectKey: "private/key",
					multipartUploadId: "upload",
					promotionAbortOnly: true,
				},
			},
			{ taskId: "media-cancel-generation", payload: { jobId: "job", version: 0 } },
			{ taskId: "media-admit-guest-generation", payload: { jobId: "job", trialId: "trial" } },
			{
				taskId: "media-terminate-refunded-subscription",
				payload: { subscriptionId: "subscription" },
			},
			{
				taskId: "media-confirm-subscription-cancellation",
				payload: { subscriptionId: "subscription" },
			},
			{
				taskId: "media-recover-subscription-checkout",
				payload: { checkoutIntentId: "checkout", sequence: 0 },
			},
		];
		for (const child of children) expect(() => assertWorkerInlineTask(parent, child)).not.toThrow();
		for (const child of [
			{ taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
			{ taskId: "media-verify-upload", payload: { assetId: "asset" } },
			{ taskId: "media-dispatch-image-kie-nano-banana-2", payload: { jobId: "job", version: 0 } },
		])
			expect(() => assertWorkerInlineTask(parent, child)).toThrow("CROSS_EXECUTOR_INLINE_TASK");
	});
	it("does not accept caller-selected executors or unregistered tasks", () => {
		expect(() => workerExecutorLane({ taskId: "unknown", payload: {} })).toThrow();
		expect(() =>
			workerExecutorLane({
				taskId: "media-poll-generation",
				payload: { attemptId: "attempt", executor: "jobs-primary" },
			}),
		).toThrow();
	});
});
