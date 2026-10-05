import type { VideoWorkflowParams } from "@repo/jobs/video-v1/contracts";
import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { VideoGenerationWorkflowV1 } from "./video-generation-v1";

const video = (env as unknown as { VIDEO_WORKFLOW: Workflow<VideoWorkflowParams> }).VIDEO_WORKFLOW;

// Paid providers, database and storage stage bodies are substituted, while the
// real Workflow class/binding, checkpoints and durable event waits run in workerd.
describe("video V1 local workerd runtime", () => {
	it.each(["early-event", "timeout-query", "template-event"])(
		"resumes %s into a fresh confirmation round without a second submit",
		async (scenario) => {
			const jobId = crypto.randomUUID();
			const id = `video-v1-${jobId}`;
			const inspection = await introspectWorkflowInstance(video, id);
			try {
				await inspection.modify(async (m) => {
					const results: Record<string, unknown> = {
						// Ordinary/legacy cases intentionally omit template, and never mock
						// preparation: an accidental extra step would hit unavailable bindings.
						"video-v1-start": {
							stage: "QUEUED",
							terminal: false,
							...(scenario === "template-event" ? { template: true } : {}),
						},
						"video-v1-input-window": { round: 0, remainingSeconds: 1800 },
						"video-v1-review-input-0": { status: "ALLOW" },
						"video-v1-submit-provider": { status: "ACCEPTED", attemptId: "a", providerTaskId: "t" },
						"video-v1-provider-window": { round: 0, remainingSeconds: 1800 },
						"video-v1-confirm-provider-0": { status: "PENDING" },
						"video-v1-provider-window-0": { round: 1, remainingSeconds: 1800 },
						"video-v1-confirm-provider-1": { status: "SUCCEEDED", attemptId: "a" },
						"video-v1-store-output": { assetId: "asset", checksum: "checksum", byteSize: "100" },
						"video-v1-output-window": { round: 0, remainingSeconds: 1800 },
						"video-v1-review-output-0": { status: "ALLOW" },
						"video-v1-finalize": { stage: "READY" },
					};
					if (scenario === "template-event")
						results["video-v1-template-prepare-0"] = { status: "ALLOW" };
					for (const [name, result] of Object.entries(results))
						await m.mockStepResult({ name }, result);
					if (scenario !== "timeout-query")
						await m.mockEvent({ type: "provider-result", payload: { forgedResultUrl: "ignored" } });
					else await m.forceEventTimeout({ name: "video-v1-provider-event-0" });
				});
				await video.create({ id, params: { jobId, schemaVersion: 1 } });
				await inspection.waitForStatus("complete");
				expect(await inspection.getOutput()).toEqual({ completed: true, stage: "READY" });
			} finally {
				await inspection.dispose();
			}
		},
	);
	it("checkpoints an exhausted uncertainty window without releasing its reservation", async () => {
		const jobId = crypto.randomUUID();
		const id = `video-v1-${jobId}`;
		const inspection = await introspectWorkflowInstance(video, id);
		try {
			await inspection.modify(async (m) => {
				for (const [name, result] of Object.entries({
					"video-v1-start": { stage: "SUBMISSION_UNCERTAIN", terminal: false },
					"video-v1-provider-window": { round: 17, remainingSeconds: 0 },
					"video-v1-confirm-provider-17": { status: "PENDING" },
					"video-v1-provider-window-17": { round: 18, remainingSeconds: 0 },
					"video-v1-needs-review-provider-deadline": { changed: true },
				}))
					await m.mockStepResult({ name }, result);
			});
			await video.create({ id, params: { jobId, schemaVersion: 1 } });
			await inspection.waitForStatus("complete");
			expect(await inspection.getOutput()).toEqual({ completed: false, stage: "NEEDS_REVIEW" });
		} finally {
			await inspection.dispose();
		}
	});
	it.each(["callback-event", "callback-timeout", "callback-retry"])(
		"handles %s without adding a periodic moderation query",
		async (scenario) => {
			const jobId = crypto.randomUUID();
			const id = `video-v1-${jobId}`;
			const inspection = await introspectWorkflowInstance(video, id);
			try {
				await inspection.modify(async (m) => {
					for (const [name, result] of Object.entries({
						"video-v1-start": { stage: "OUTPUT_REVIEW", terminal: false },
						"video-v1-store-output": { assetId: "asset", checksum: "checksum", byteSize: "100" },
						"video-v1-output-window": { round: 0, remainingSeconds: 1800 },
						"video-v1-review-output-0": { status: "PENDING", waitFor: "callback" },
						"video-v1-output-window-0": { round: 1, remainingSeconds: 1800 },
						// If the timeout incorrectly starts another query, this clean mocked
						// response would cause READY and fail the NEEDS_REVIEW assertion.
						"video-v1-review-output-1":
							scenario === "callback-retry"
								? { status: "PENDING", waitFor: "confirmation-retry", retryAfterSeconds: 1 }
								: { status: "ALLOW" },
						"video-v1-output-window-1": { round: 2, remainingSeconds: 1800 },
						"video-v1-review-output-2": {
							status: "PENDING",
							waitFor: "confirmation-retry",
							retryAfterSeconds: 3,
						},
						"video-v1-output-window-2": { round: 3, remainingSeconds: 1800 },
						"video-v1-review-output-3": { status: "ALLOW" },
						"video-v1-needs-review-output-review-callback-deadline": { changed: true },
						"video-v1-finalize": { stage: "READY" },
					}))
						await m.mockStepResult({ name }, result);
					if (scenario !== "callback-timeout")
						await m.mockEvent({ type: "moderation-result", payload: { forgedDecision: "ALLOW" } });
					else await m.forceEventTimeout({ name: "video-v1-output-event-0" });
				});
				await video.create({ id, params: { jobId, schemaVersion: 1 } });
				await inspection.waitForStatus("complete");
				expect(await inspection.getOutput()).toEqual(
					scenario !== "callback-timeout"
						? { completed: true, stage: "READY" }
						: { completed: false, stage: "NEEDS_REVIEW" },
				);
			} finally {
				await inspection.dispose();
			}
		},
	);
});
export { VideoGenerationWorkflowV1 };
