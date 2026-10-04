import {
	listPendingVideoWebhookEvents,
	markVideoWebhookNotified,
	postponeVideoWebhookNotification,
} from "@repo/database/video-v1-execution";
import {
	listVideoRecoveryCandidates,
	markVideoNeedsReview,
	postponeVideoRecovery,
} from "@repo/database/video-v1-recovery";

import { ensureVideoWorkflowStarted } from "./admission";
import type { RecoverySummary, VideoStartState, VideoWorkflowBinding } from "./contracts";
import { notifyPendingSeeapiVideoModerationEvents } from "./seeapi-webhooks";
import { getVideoWorkflowBinding } from "./workflow-binding";

export interface VideoRecoveryDependencies {
	candidates(
		this: void,
		limit: number,
	): Promise<Array<{ jobId: string; workflowInstanceId: string; startState: VideoStartState }>>;
	start(this: void, jobId: string, binding: VideoWorkflowBinding): Promise<VideoStartState>;
	postpone(this: void, jobId: string): Promise<unknown>;
	postponeEvent(this: void, eventId: string): Promise<unknown>;
	needsReview(this: void, jobId: string, reason: string): Promise<unknown>;
	events(
		this: void,
		limit: number,
	): Promise<Array<{ eventId: string; jobId: string; workflowInstanceId: string }>>;
	notified(this: void, eventId: string): Promise<unknown>;
	moderationEvents(
		this: void,
		jobId: string,
		binding: VideoWorkflowBinding,
		limit: number,
	): Promise<{ notified: number; failed: number }>;
}
const defaults: VideoRecoveryDependencies = {
	candidates: listVideoRecoveryCandidates,
	start: ensureVideoWorkflowStarted,
	postpone: postponeVideoRecovery,
	postponeEvent: postponeVideoWebhookNotification,
	needsReview: markVideoNeedsReview,
	events: listPendingVideoWebhookEvents,
	notified: markVideoWebhookNotified,
	moderationEvents: (jobId, binding, limit) =>
		notifyPendingSeeapiVideoModerationEvents({ jobId, binding, limit }),
};

/** Indexed bounded exception recovery. Admission gates do not stop accepted work. */
export async function recoverVideoExecutions(
	batchLimit: number,
	binding = getVideoWorkflowBinding(),
	dependencies = defaults,
): Promise<RecoverySummary> {
	if (!binding) throw new Error("VIDEO_WORKFLOW_BINDING_REQUIRED");
	const limit = Math.min(100, Math.max(1, Math.floor(batchLimit)));
	const result: RecoverySummary = { inspected: 0, started: 0, notified: 0, failed: 0 };
	for (const execution of await dependencies.candidates(limit)) {
		result.inspected++;
		try {
			if (execution.workflowInstanceId !== `video-v1-${execution.jobId}`) {
				await dependencies.needsReview(execution.jobId, "WORKFLOW_IDENTITY_MISMATCH");
				result.failed++;
				continue;
			}
			if (execution.startState !== "STARTED") {
				if ((await dependencies.start(execution.jobId, binding)) === "STARTED") result.started++;
			} else {
				const instance = await binding.get(execution.workflowInstanceId);
				const state = await instance.status();
				if (["errored", "terminated", "complete", "unknown"].includes(state.status)) {
					// Never restart from the top after platform data loss. Preserve the
					// attempt and reservation for an audited operator decision.
					await dependencies.needsReview(execution.jobId, `WORKFLOW_${state.status.toUpperCase()}`);
					result.failed++;
					continue;
				}
			}
			// Only retry delivery for this bounded, video-owned recovery candidate.
			// Persisted callback evidence is never queried globally or re-fetched here.
			const moderation = await dependencies.moderationEvents(execution.jobId, binding, limit);
			result.notified += moderation.notified;
			result.failed += moderation.failed;
			await dependencies.postpone(execution.jobId);
		} catch {
			result.failed++;
			await dependencies.postpone(execution.jobId).catch(() => undefined);
		}
	}
	for (const event of await dependencies.events(limit)) {
		try {
			if (event.workflowInstanceId !== `video-v1-${event.jobId}`)
				throw new Error("VIDEO_EVENT_IDENTITY_MISMATCH");
			const instance = await binding.get(event.workflowInstanceId);
			await instance.sendEvent({
				type: "provider-result",
				payload: { jobId: event.jobId, eventId: event.eventId },
			});
			await dependencies.notified(event.eventId);
			result.notified++;
		} catch {
			result.failed++;
			await dependencies.postponeEvent(event.eventId).catch(() => undefined);
		}
	}
	return result;
}
