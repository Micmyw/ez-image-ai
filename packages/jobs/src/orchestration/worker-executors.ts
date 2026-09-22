import type { TaskRequest } from "./contracts";
import { dispatchRouteForTask, parseTaskRequest } from "./registry";

export const WORKER_EXECUTORS = {
	// Keep the original object identity so old Workflows and new heavy transfers
	// still share the same single slot during a rolling deployment.
	heavy: { name: "jobs-primary", maxActive: 1 },
	control: { name: "jobs-control", maxActive: 4 },
	maintenance: { name: "jobs-maintenance", maxActive: 1 },
} as const;

export type WorkerExecutorLane = keyof typeof WORKER_EXECUTORS;

/** Admission classes only; PostgreSQL remains the authority for task ownership. */
export function workerExecutorLane(input: TaskRequest): WorkerExecutorLane {
	const request = parseTaskRequest(input);
	const route = dispatchRouteForTask(request.taskId);
	if (route) {
		// These adapters return small asynchronous acceptance envelopes. Synchronous
		// Gemini/OpenRouter responses can include complete base64 images. New
		// adapters conservatively use the heavy slot until explicitly reviewed.
		return ["kie", "fal", "replicate"].includes(route.provider) ? "control" : "heavy";
	}
	switch (request.taskId) {
		case "media-finalize-generation":
			return "heavy";
		case "media-verify-upload":
			// Ordinary checks use bounded headers and streaming checksum validation.
			// Explicit legacy reinspection stays with the heavy transfers.
			return request.payload.allowQuarantinedReverification === true ? "heavy" : "control";
		case "media-poll-generation":
		case "media-process-provider-webhook":
		case "media-settle-generation":
			return "control";
		case "media-deliver-outbox":
		case "media-admit-guest-generation":
		case "media-cancel-generation":
		case "media-process-payment-event":
		case "media-terminate-refunded-subscription":
		case "media-confirm-subscription-cancellation":
		case "media-recover-subscription-checkout":
		case "media-delete-object":
		case "media-abort-multipart":
		case "media-cleanup-upload-promotion":
		case "media-abort-promotion-multipart":
		case "media-expire-guest-media":
		case "media-expire-uploads":
		case "media-grant-billing-periods":
		case "media-reconcile-generations":
		case "media-reconcile-subscriptions":
		case "media-reconcile-provider-payments":
		case "media-reconcile-subscriptions-continuation":
		case "media-recover-finalizing-generations":
		case "media-recover-verifications":
		case "media-recover-payment-events":
			return "maintenance";
		default:
			return "heavy";
	}
}

export function workerExecutorForTask(request: TaskRequest) {
	return WORKER_EXECUTORS[workerExecutorLane(request)];
}

/** Inline Outbox children retain the parent's slot and completion-before-ACK. */
export function assertWorkerInlineTask(parent: TaskRequest, child: TaskRequest): void {
	if (
		parent.taskId !== "media-deliver-outbox" ||
		workerExecutorLane(parent) !== "maintenance" ||
		workerExecutorLane(child) !== "maintenance"
	) {
		throw new Error("CROSS_EXECUTOR_INLINE_TASK");
	}
}
