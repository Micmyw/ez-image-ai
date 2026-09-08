import { STATIC_DISPATCH_ROUTE_MANIFEST } from "@repo/ai/media/catalog/dispatch-manifest";
import { describe, expect, it } from "vitest";

import { maintenanceTasksAt, parseTaskRequest, taskDefinition } from "./registry";

const dispatchTask = "media-dispatch-image-kie-nano-banana-2";

describe("orchestration task admission", () => {
	it("rejects unregistered task IDs, unknown properties, and invalid scalar values", () => {
		for (const value of [
			{ taskId: "arbitrary-code", payload: {} },
			{ taskId: "media-deliver-outbox", payload: { command: "anything" } },
			{ taskId: "media-poll-generation", payload: { attemptId: " " } },
			{ taskId: "media-poll-generation", payload: { attemptId: "attempt-1" }, admin: true },
			{ taskId: dispatchTask, payload: { jobId: "job-1", version: -1 } },
			{
				taskId: "media-verify-upload",
				payload: { assetId: "asset-1", allowQuarantinedReverification: "true" },
			},
			{
				taskId: "media-reconcile-subscriptions-continuation",
				payload: { sweepId: "sweep-1", continuationKey: "next", sequence: 1.5 },
			},
		]) {
			expect(() => parseTaskRequest(value)).toThrow();
		}
	});

	it("binds optional provider pins to the static route and rejects arbitrary remote inputs", () => {
		expect(
			parseTaskRequest({ taskId: dispatchTask, payload: { jobId: "job-1", version: 0 } }),
		).toEqual({ taskId: dispatchTask, payload: { jobId: "job-1", version: 0 } });
		for (const extra of [
			{ provider: "fal" },
			{ providerModelId: "unknown-model" },
			{ sourceUrl: "https://example.com/private" },
		]) {
			expect(() =>
				parseTaskRequest({
					taskId: dispatchTask,
					payload: { jobId: "job-1", version: 0, ...extra },
				}),
			).toThrow();
		}
	});

	it("requires matching cleanup reservation identity and complete release metadata", () => {
		for (const extra of [
			{ storageReservationReferenceKey: "generation-output:other-asset" },
			{ uploadSessionId: "session-1" },
			{ reservationStatus: "RELEASED" },
		]) {
			expect(() =>
				parseTaskRequest({
					taskId: "media-delete-object",
					payload: { assetId: "asset-1", objectKey: "private/source", ...extra },
				}),
			).toThrow();
		}
		expect(
			parseTaskRequest({
				taskId: "media-abort-promotion-multipart",
				payload: {
					assetId: "asset-1",
					objectKey: "private/source",
					multipartUploadId: "multipart-1",
					promotionAbortOnly: true,
				},
			}).payload.promotionAbortOnly,
		).toBe(true);
	});
});

describe("orchestration capacity and maintenance", () => {
	it("declares every canonical route queue and preserves conservative submission retry budgets", () => {
		for (const route of STATIC_DISPATCH_ROUTE_MANIFEST) {
			const actual = taskDefinition(route.taskId);
			expect(actual.queue).toBe(route.queueName);
			const singleSubmission =
				route.provider === "openrouter" ||
				(route.provider === "kie" && route.mediaKind === "image");
			expect(actual.maxAttempts).toBe(singleSubmission ? 1 : 5);
			expect(actual.timeoutSeconds).toBe(route.provider === "openrouter" ? 300 : 60);
		}
	});
	it("keeps provider submission retry policy and model precedence", () => {
		expect(
			taskDefinition(dispatchTask, {
				MEDIA_IMAGE_SUBMISSION_CONCURRENCY: "9",
				MEDIA_PROVIDER_QUEUE_LIMITS: "kie=4",
				MEDIA_MODEL_QUEUE_LIMITS: "kie:nano-banana-2=2",
			}),
		).toEqual({
			maxAttempts: 1,
			timeoutSeconds: 60,
			queue: "media-image-kie-nano-banana-2",
			concurrency: 2,
		});
		expect(taskDefinition("media-dispatch-video-kie-veo3")).toMatchObject({
			maxAttempts: 5,
			concurrency: 2,
		});
		expect(
			taskDefinition("media-dispatch-image-openrouter-sourceful_riverflow-v2.5-fast"),
		).toMatchObject({ maxAttempts: 1, timeoutSeconds: 300 });
		expect(
			taskDefinition("media-finalize-generation", { MEDIA_FINALIZATION_CONCURRENCY: "7" }),
		).toMatchObject({ timeoutSeconds: 900, concurrency: 7 });
		expect(taskDefinition("media-process-payment-event").maxAttempts).toBe(8);
		expect(() => taskDefinition("not-a-task")).toThrow();
	});

	it("preserves the nine UTC schedules including separate hourly minute offsets", () => {
		const at = (minute: number) => maintenanceTasksAt(Date.UTC(2026, 8, 8, 4, minute));
		const everyMinute = [
			"media-deliver-outbox",
			"media-recover-finalizing-generations",
			"media-recover-verifications",
			"media-recover-payment-events",
		];
		expect(at(1).sort()).toEqual(everyMinute.sort());
		expect(at(5).sort()).toEqual(
			[
				...everyMinute,
				"media-reconcile-generations",
				"media-expire-guest-media",
				"media-grant-billing-periods",
			].sort(),
		);
		expect(at(15).sort()).toEqual(
			[
				...everyMinute,
				"media-reconcile-generations",
				"media-expire-guest-media",
				"media-expire-uploads",
				"media-reconcile-subscriptions",
			].sort(),
		);
		expect(new Set(Array.from({ length: 60 }, (_, minute) => at(minute)).flat()).size).toBe(9);
		expect(() => maintenanceTasksAt(Number.NaN)).toThrow();
	});
});
