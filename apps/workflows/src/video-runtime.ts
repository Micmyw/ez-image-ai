import { readVideoV1Config } from "@repo/config/video-v1";
import { createRuntimeDatabaseClient, runWithDatabaseClient } from "@repo/database/client";
import {
	getVideoWaitWindow,
	getVideoWorkflowCheckpoint,
	markVideoNeedsReview,
} from "@repo/database/video-v1-recovery";
import { recoverVideoResources } from "@repo/jobs/video-v1/cleanup";
import type { VideoWorkflowBinding } from "@repo/jobs/video-v1/contracts";
import {
	failVideoJob,
	finalizeVideoJob,
	reviewStoredVideo,
	storeVideoOutput,
} from "@repo/jobs/video-v1/fulfillment";
import { recoverVideoExecutions } from "@repo/jobs/video-v1/recovery";
import {
	confirmVideoProviderResult,
	reviewVideoInput,
	submitVideoAttempt,
} from "@repo/jobs/video-v1/submission";
import { recordVideoStageMetric } from "@repo/jobs/video-v1/telemetry";
import { runWithVideoWorkflowBinding } from "@repo/jobs/video-v1/workflow-binding";
import {
	createCloudflareImagesProcessor,
	type CloudflareImagesBinding,
} from "@repo/storage/image-processing/cloudflare-images";
import { runWithImageProcessor } from "@repo/storage/image-processing/context";
import { runWithCloudflareRemoteMedia } from "@repo/storage/lib/cloudflare-remote-media";

import type { VideoWorkflowServices } from "./video-orchestrator";

export interface VideoRuntimeEnvironment {
	HYPERDRIVE: { connectionString: string };
	IMAGES: CloudflareImagesBinding;
	VIDEO_WORKFLOW: VideoWorkflowBinding;
	VIDEO_MEDIA_BUCKET?: unknown;
	VIDEO_V1_UPLOAD_CORS_READY?: string;
}

/** A fresh connection per step, closed before durable sleeps/event waits. */
export async function withVideoRuntime<T>(
	env: VideoRuntimeEnvironment,
	operation: () => Promise<T>,
): Promise<T> {
	if (!env.HYPERDRIVE?.connectionString || !env.IMAGES || !env.VIDEO_WORKFLOW)
		throw new Error("VIDEO_WORKER_BINDINGS_REQUIRED");
	const database = createRuntimeDatabaseClient(env.HYPERDRIVE.connectionString);
	try {
		return await runWithDatabaseClient(database, () =>
			runWithVideoWorkflowBinding(
				env.VIDEO_WORKFLOW,
				() =>
					runWithImageProcessor(createCloudflareImagesProcessor(env.IMAGES), () =>
						runWithCloudflareRemoteMedia(operation),
					),
				{
					r2: Boolean(env.VIDEO_MEDIA_BUCKET),
					hyperdrive: true,
					uploadCors: env.VIDEO_V1_UPLOAD_CORS_READY === "true",
				},
			),
		);
	} finally {
		await database.$disconnect();
	}
}

export function videoWorkflowServices(env: VideoRuntimeEnvironment): VideoWorkflowServices {
	const config = readVideoV1Config(process.env);
	const scoped = <T>(fn: () => Promise<T>) => withVideoRuntime(env, fn);
	const measured = async <T>(jobId: string, stage: string, fn: () => Promise<T>) => {
		const started = Date.now();
		try {
			const result = await scoped(fn);
			recordVideoStageMetric({ jobId, stage, durationMs: Date.now() - started });
			return result;
		} catch (error) {
			recordVideoStageMetric({
				jobId,
				stage,
				durationMs: Date.now() - started,
				errorCode: "VIDEO_STAGE_ERROR",
			});
			throw error;
		}
	};
	return {
		checkpoint: (jobId) => scoped(() => getVideoWorkflowCheckpoint(jobId)),
		window: (jobId, phase, round) =>
			scoped(() =>
				getVideoWaitWindow({
					jobId,
					phase,
					round,
					deadlineSeconds:
						phase === "provider"
							? config.providerDeadlineSeconds || 1800
							: config.moderationDeadlineSeconds || 1800,
				}),
			),
		reviewInput: (jobId) => measured(jobId, "input-review", () => reviewVideoInput(jobId)),
		submit: (jobId) => measured(jobId, "provider-submit", () => submitVideoAttempt(jobId)),
		confirm: (jobId) =>
			measured(jobId, "provider-confirm", () => confirmVideoProviderResult(jobId)),
		store: (jobId) => measured(jobId, "store-output", () => storeVideoOutput(jobId)),
		reviewOutput: (jobId) => measured(jobId, "output-review", () => reviewStoredVideo(jobId)),
		finalize: (jobId) => measured(jobId, "finalize", () => finalizeVideoJob(jobId)),
		fail: (jobId, code, rejected) => scoped(() => failVideoJob(jobId, code, rejected)),
		needsReview: (jobId, code) => scoped(() => markVideoNeedsReview(jobId, code)),
		providerPollSeconds: config.providerPollSeconds || 30,
		moderationPollSeconds: config.moderationPollSeconds || 30,
	};
}

/** Two independent bounded pages; cleanup cannot occupy legacy maintenance slots. */
export async function runVideoMaintenance(env: VideoRuntimeEnvironment) {
	const results = await Promise.allSettled([
		withVideoRuntime(env, () => recoverVideoExecutions(25, env.VIDEO_WORKFLOW)),
		withVideoRuntime(env, () => recoverVideoResources(20)),
	]);
	if (results.some((result) => result.status === "rejected"))
		throw new Error("VIDEO_RECOVERY_FAILED");
	return results;
}
