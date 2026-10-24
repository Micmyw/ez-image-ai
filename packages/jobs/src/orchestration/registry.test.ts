import { STATIC_DISPATCH_ROUTE_MANIFEST } from "@repo/ai/media/catalog/dispatch-manifest";
import { describe, expect, it } from "vitest";

import {
	maintenanceTasksAt,
	parseEventDeliveryResult,
	parseTaskRequest,
	taskDefinition,
} from "./registry";

const dispatchTask = "media-dispatch-image-kie-nano-banana-2";

describe("orchestration task admission", () => {
	it("requires exact receipt identity and typed review progress for a fused execution", () => {
		const request = { taskId: "media-execute-event", payload: { eventId: "event" } };
		const child = {
			taskId: "media-verify-upload",
			payload: { assetId: "asset" },
			outboxReceipt: { eventId: "event", workerId: "workflow:one", leaseToken: "lease" },
		};
		const result = {
			preparedEvent: null,
			executedEvent: child,
			deliveryState: "pending",
			poll: {
				done: false,
				waitSeconds: 5,
				phaseOwner: { workflowId: "workflow", phaseKey: "phase", epoch: 1 },
			},
		};
		expect(parseEventDeliveryResult(request, result)).toEqual(result);
		for (const invalid of [
			{ ...result, preparedEvent: child },
			{ ...result, executedEvent: { ...child, outboxReceipt: undefined } },
			{
				...result,
				executedEvent: { ...child, outboxReceipt: { ...child.outboxReceipt, eventId: "other" } },
			},
			{ ...result, deliveryState: undefined },
			{ ...result, poll: undefined },
			{ ...result, poll: { ...result.poll, phaseOwner: { ...result.poll.phaseOwner, epoch: 0 } } },
			{ ...result, eventRecoveryState: "completed" },
		])
			expect(() => parseEventDeliveryResult(request, invalid)).toThrow();
		expect(() =>
			parseEventDeliveryResult(
				{ ...request, payload: { ...request.payload, recoverOnly: true } },
				result,
			),
		).toThrow();
		for (const eventRecoveryState of ["completed", "held", "missing"])
			expect(
				parseEventDeliveryResult(
					{ ...request, payload: { ...request.payload, recoverOnly: true } },
					{
						preparedEvent: null,
						eventRecoveryState,
					},
				),
			).toEqual({ preparedEvent: null, eventRecoveryState });
		expect(taskDefinition("media-execute-event").maxAttempts).toBe(1);
	});
	it("admits only a bounded due time for an unclaimed prepared event", () => {
		const request = { taskId: "media-prepare-event", payload: { eventId: "event" } };
		for (const eventRetryAfterMs of [0, 811])
			expect(
				parseEventDeliveryResult(request, {
					preparedEvent: null,
					eventRetryAfterMs,
					privateUrl: "secret",
				}),
			).toEqual({ preparedEvent: null, eventRetryAfterMs });
		for (const eventRetryAfterMs of [-1, 1.5, Infinity, NaN, "later", null])
			expect(() =>
				parseEventDeliveryResult(request, { preparedEvent: null, eventRetryAfterMs }),
			).toThrow();
		expect(() =>
			parseEventDeliveryResult(request, {
				preparedEvent: null,
				eventRetryAfterMs: 811,
				eventRetryAt: 1_800_000_000_811,
			}),
		).toThrow();
		expect(
			parseEventDeliveryResult(request, {
				preparedEvent: null,
				eventRetryAt: 1_800_000_000_811,
				privateUrl: "secret",
			}),
		).toEqual({ preparedEvent: null, eventRetryAt: 1_800_000_000_811 });
		for (const eventRetryAt of [0, -1, 1.5, Infinity, NaN, "later", null])
			expect(() =>
				parseEventDeliveryResult(request, { preparedEvent: null, eventRetryAt }),
			).toThrow();
		expect(() =>
			parseEventDeliveryResult(request, {
				preparedEvent: {
					taskId: "media-verify-upload",
					payload: { assetId: "asset" },
					outboxReceipt: { eventId: "event", workerId: "worker", leaseToken: "fence" },
				},
				eventRetryAt: 1_800_000_000_811,
			}),
		).toThrow();
	});
	it("admits account-copy identities without client-selected storage locations", () => {
		for (const taskId of ["media-copy-account-input", "media-cleanup-account-input-copy"]) {
			expect(parseTaskRequest({ taskId, payload: { promotionId: "promotion-1" } })).toEqual({
				taskId,
				payload: { promotionId: "promotion-1" },
			});
			for (const extra of [
				{ objectKey: "users/other/final" },
				{ ownerId: "other" },
				{ leaseToken: "old" },
			])
				expect(() =>
					parseTaskRequest({ taskId, payload: { promotionId: "promotion-1", ...extra } }),
				).toThrow();
		}
		expect(taskDefinition("media-copy-account-input")).toMatchObject({
			queue: "media-account-input-copy",
			timeoutSeconds: 120,
		});
		expect(taskDefinition("media-cleanup-account-input-copy")).toMatchObject({
			queue: "media-account-input-copy-cleanup",
		});
		expect(maintenanceTasksAt(Date.UTC(2026, 9, 19, 12, 1))).toContain(
			"media-recover-account-input-copies",
		);
	});
	it("preserves bounded diagnostic identities without admitting arbitrary trace data", () => {
		const request = {
			taskId: "media-verify-upload",
			payload: { assetId: "asset-1" },
			trace: {
				outboxEventId: "event-1",
				dueAt: 1_800_000_000_000,
				requestId: "request-1",
				pollTick: 0,
			},
		};
		expect(parseTaskRequest(request)).toEqual(request);
		for (const trace of [
			{ ...request.trace, prompt: "private prompt" },
			{ ...request.trace, dueAt: Number.NaN },
			{ ...request.trace, pollTick: -1 },
			{ ...request.trace, pollTick: 0.5 },
			{ ...request.trace, requestId: "https://private/?token=secret" },
		])
			expect(() => parseTaskRequest({ ...request, trace })).toThrow();
	});
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
			{ taskId: "media-reconcile-provider-payments", payload: { provider: "stripe" } },
			{
				taskId: "media-reconcile-provider-payments",
				payload: { provider: "paypal", scope: "another-merchant" },
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
		for (const prefix of ["generation-output", "media-draft", "temporary-reference"]) {
			expect(
				parseTaskRequest({
					taskId: "media-delete-object",
					payload: {
						assetId: "asset-1",
						objectKey: "private/source",
						storageReservationReferenceKey: `${prefix}:asset-1`,
					},
				}).payload.storageReservationReferenceKey,
			).toBe(`${prefix}:asset-1`);
		}
		for (const extra of [
			{ storageReservationReferenceKey: "generation-output:other-asset" },
			{ storageReservationReferenceKey: "temporary-reference:other-asset" },
			{ storageReservationReferenceKey: "media-draft:other-asset" },
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

	it("preserves the UTC schedules and includes durable account-copy recovery", () => {
		const at = (minute: number) => maintenanceTasksAt(Date.UTC(2026, 8, 8, 4, minute));
		const everyMinute = [
			"media-recover-account-input-copies",
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
		expect(new Set(Array.from({ length: 60 }, (_, minute) => at(minute)).flat()).size).toBe(10);
		expect(() => maintenanceTasksAt(Number.NaN)).toThrow();
	});
});
