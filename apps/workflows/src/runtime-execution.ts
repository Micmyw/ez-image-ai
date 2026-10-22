import {
	createRuntimeDatabaseClient,
	runWithDatabaseClient,
	type DatabaseQueryContext,
} from "@repo/database/client";
import { executeTask } from "@repo/jobs/orchestration/executor";
import { executePollingTick } from "@repo/jobs/orchestration/polling";
import { assertWorkerInlineTask } from "@repo/jobs/orchestration/worker-executors";
import { runWithMediaJobEvents, type MediaJobEventsNamespace } from "@repo/jobs/realtime/context";
import {
	createCloudflareImagesProcessor,
	type CloudflareImagesBinding,
} from "@repo/storage/image-processing/cloudflare-images";
import { runWithImageProcessor } from "@repo/storage/image-processing/context";
import { runWithCloudflareRemoteMedia } from "@repo/storage/lib/cloudflare-remote-media";

import { createWorkflowBindingDispatcher, type JobsParams } from "./dispatch";
import { createWorkerExecutionHandler, type WorkerExecutionOptions } from "./execution";
import type { VideoRuntimeEnvironment } from "./video-runtime";

export interface RuntimeExecutionEnvironment extends VideoRuntimeEnvironment {
	WORKFLOWS_DISPATCH_SECRET: string;
	WORKFLOWS_DISPATCH_URL: string;
	HYPERDRIVE: { connectionString: string };
	IMAGES: CloudflareImagesBinding;
	JOBS: Workflow<JobsParams>;
	MEDIA_JOB_EVENTS?: MediaJobEventsNamespace;
	MEDIA_SETTLEMENT_FRESH_READ_ENABLED?: string;
}

/** The legacy DO and stateless service use the same private runtime and receipts. */
export function createRuntimeExecutionHandler(
	env: RuntimeExecutionEnvironment,
	options: Pick<
		WorkerExecutionOptions,
		"maxActive" | "admission" | "acceptsTask" | "onEvent" | "streamingTransfersOnly"
	>,
) {
	return createWorkerExecutionHandler({
		...options,
		secret: env.WORKFLOWS_DISPATCH_SECRET,
		execute: (task, context) =>
			scoped(
				env,
				{
					runId: context.runId,
					taskId: task.taskId,
					...(typeof task.payload.jobId === "string" ? { jobId: task.payload.jobId } : {}),
					...(typeof task.payload.assetId === "string" ? { assetId: task.payload.assetId } : {}),
				},
				() =>
					executeTask(task, context, {
						assertInlineTask: assertWorkerInlineTask,
						...(options.streamingTransfersOnly ? { streamingTransfersOnly: true } : {}),
						dispatch: createWorkflowBindingDispatcher({
							url: env.WORKFLOWS_DISPATCH_URL,
							secret: env.WORKFLOWS_DISPATCH_SECRET,
							workflows: env.JOBS,
						}),
					}),
			),
		poll: (input, context) =>
			scoped(
				env,
				{
					runId: context.runId,
					taskId: "media-poll-generation",
				},
				() => executePollingTick(input, undefined, context),
			),
	});
}

async function scoped<T>(
	env: RuntimeExecutionEnvironment,
	diagnostics: DatabaseQueryContext,
	operation: () => Promise<T>,
): Promise<T> {
	const database = createRuntimeDatabaseClient(env.HYPERDRIVE.connectionString, diagnostics);
	try {
		return await runWithDatabaseClient(database, () =>
			runWithImageProcessor(createCloudflareImagesProcessor(env.IMAGES), () =>
				runWithCloudflareRemoteMedia(() => runWithMediaJobEvents(env.MEDIA_JOB_EVENTS, operation)),
			),
		);
	} finally {
		await database.$disconnect();
	}
}
