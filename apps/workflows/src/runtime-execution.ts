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
import { runWithRequestDefer, type RequestDefer } from "@repo/utils/request-lifecycle";

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
	> & { waitUntil?: RequestDefer },
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
				options.waitUntil,
			),
		poll: (input, context) =>
			scoped(
				env,
				{
					runId: context.runId,
					taskId: "media-poll-generation",
				},
				() => executePollingTick(input, undefined, context),
				options.waitUntil,
			),
	});
}

async function scoped<T>(
	env: RuntimeExecutionEnvironment,
	diagnostics: DatabaseQueryContext,
	operation: () => Promise<T>,
	waitUntil?: RequestDefer,
): Promise<T> {
	const database = createRuntimeDatabaseClient(env.HYPERDRIVE.connectionString, diagnostics);
	const pending = new Set<Promise<void>>();
	let registered = false;
	let closing = false;
	let finish!: () => void;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const lifetime = finished.then(async () => {
		// Live tasks can register descendants; their ACKs need the same client too.
		while (pending.size) await Promise.all([...pending]);
		closing = true;
		await database.$disconnect();
	});
	try {
		// Register before executing business work, independently of response cancellation.
		waitUntil?.(lifetime);
	} catch (error) {
		finish();
		await lifetime.catch(() => {});
		throw error;
	}
	const defer: RequestDefer = (promise) => {
		if (closing) throw new Error("WORKER_RUNTIME_SCOPE_CLOSED");
		registered = true;
		// Observe rejection immediately; a notification failure cannot replay business work.
		const task = Promise.resolve(promise).then(
			() => {
				pending.delete(task);
			},
			() => {
				pending.delete(task);
			},
		);
		pending.add(task);
	};
	try {
		return await runWithRequestDefer(defer, () =>
			runWithDatabaseClient(database, () =>
				runWithImageProcessor(createCloudflareImagesProcessor(env.IMAGES), () =>
					runWithCloudflareRemoteMedia(() =>
						runWithMediaJobEvents(env.MEDIA_JOB_EVENTS, operation),
					),
				),
			),
		);
	} finally {
		finish();
		// With no platform lifetime, draining remains synchronous. Empty scopes retain
		// their original disconnect boundary; no background work leaks into another request.
		if (!waitUntil || !registered) await lifetime;
	}
}
