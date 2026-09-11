import { createRuntimeDatabaseClient, runWithDatabaseClient } from "@repo/database/client";
import { signRequest, workflowInstanceId } from "@repo/jobs/orchestration/auth";
import { executeTask } from "@repo/jobs/orchestration/executor";
import { executePollingTick } from "@repo/jobs/orchestration/polling";
import { taskDefinition } from "@repo/jobs/orchestration/registry";
import {
	createCloudflareImagesProcessor,
	type CloudflareImagesBinding,
} from "@repo/storage/image-processing/cloudflare-images";
import { runWithImageProcessor } from "@repo/storage/image-processing/context";
import { runWithCloudflareRemoteMedia } from "@repo/storage/lib/cloudflare-remote-media";
import {
	DurableObject,
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";

import { handleDispatch, type JobsParams } from "./dispatch";
import { createWorkerExecutionHandler } from "./execution";
import {
	runMaintenance,
	runPolling,
	runTask,
	type DurableSteps,
	type InvokeTask,
	type InvocationResult,
} from "./orchestrator";

export interface WorkersEnvironment {
	WORKFLOWS_DISPATCH_SECRET: string;
	WORKFLOWS_DISPATCH_URL: string;
	HYPERDRIVE: { connectionString: string };
	IMAGES: CloudflareImagesBinding;
	JOBS_EXECUTOR: DurableObjectNamespace<WorkerJobs>;
	JOBS: Workflow<JobsParams>;
}

export class WorkerJobs extends DurableObject<WorkersEnvironment> {
	private handler?: ReturnType<typeof createWorkerExecutionHandler>;

	override async fetch(request: Request): Promise<Response> {
		this.handler ??= createWorkerExecutionHandler({
			secret: this.env.WORKFLOWS_DISPATCH_SECRET,
			// A Worker has 128 MiB, shared by all its invocations. Serialize heavy
			// transfers initially; the Node/Container executor retains its own cap.
			maxActive: 1,
			execute: (task, context) => this.scoped(() => executeTask(task, context)),
			poll: (input) => this.scoped(() => executePollingTick(input)),
		});
		const execution = this.handler(request);
		// Keep admitted work alive if its delivery connection is lost. Workflows
		// may retry delivery; PostgreSQL leases still decide who owns the work.
		this.ctx.waitUntil(execution.then(() => undefined));
		return execution;
	}

	private async scoped<T>(operation: () => Promise<T>): Promise<T> {
		const database = createRuntimeDatabaseClient(this.env.HYPERDRIVE.connectionString);
		try {
			return await runWithDatabaseClient(database, () =>
				runWithImageProcessor(createCloudflareImagesProcessor(this.env.IMAGES), () =>
					runWithCloudflareRemoteMedia(operation),
				),
			);
		} finally {
			await database.$disconnect();
		}
	}
}

export class JobsWorkflow extends WorkflowEntrypoint<WorkersEnvironment, JobsParams> {
	override async run(event: WorkflowEvent<JobsParams>, step: WorkflowStep) {
		const invoke: InvokeTask = async (request, context): Promise<InvocationResult> => {
			const body = JSON.stringify({ request, context });
			const executor = this.env.JOBS_EXECUTOR.get(
				this.env.JOBS_EXECUTOR.idFromName("jobs-primary"),
			);
			const response = await executor.fetch(
				new Request("https://executor/internal/execute", {
					method: "POST",
					body,
					headers: await signRequest(
						this.env.WORKFLOWS_DISPATCH_SECRET,
						"POST",
						"/internal/execute",
						body,
					),
					signal: AbortSignal.timeout((taskDefinition(request.taskId).timeoutSeconds + 10) * 1000),
				}),
			);
			if (response.status === 429) return { status: "busy" };
			if (!response.ok) return { status: "failed" };
			const result = (await response.json()) as InvocationResult;
			if (result.status !== "ok") throw new Error("INVALID_RUNTIME_RESPONSE");
			return result;
		};
		const steps = step as unknown as DurableSteps;
		if (event.payload.kind === "maintenance")
			await runMaintenance(event.payload.timestamp, event.instanceId, steps, invoke);
		else if (event.payload.request.taskId === "media-poll-generation")
			await runPolling(event.payload.request, event.instanceId, steps, invoke);
		else await runTask(event.payload.request, event.instanceId, steps, invoke);
		return { completed: true };
	}
}

export default {
	fetch(request, env) {
		return handleDispatch(request, env.WORKFLOWS_DISPATCH_SECRET, env.JOBS);
	},
	async scheduled(controller, env) {
		const timestamp = Math.floor(controller.scheduledTime / 60_000) * 60_000;
		const id = await workflowInstanceId({ maintenance: timestamp });
		await env.JOBS.createBatch([
			{
				id,
				params: { kind: "maintenance", timestamp },
				retention: { successRetention: "1 day", errorRetention: "7 days" },
			},
		]);
	},
} satisfies ExportedHandler<WorkersEnvironment>;
