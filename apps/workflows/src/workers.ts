import { hydrateVideoRuntimeEnvironment } from "@repo/config/video-runtime-environment";
import { workflowInstanceId } from "@repo/jobs/orchestration/auth";
import {
	workerExecutorForTask,
	workerExecutorLane,
	workerServiceForTask,
	WORKER_EXECUTORS,
} from "@repo/jobs/orchestration/worker-executors";
import {
	DurableObject,
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";

import { handleDispatch, type JobsParams } from "./dispatch";
import { createExecutorInvoker } from "./invoke";
import { handleJobEventsRequest, isJobEventsRequest } from "./job-events";
import {
	createRuntimeExecutionHandler,
	type RuntimeExecutionEnvironment,
} from "./runtime-execution";
import { createWakeContinuationScheduler, handleWake, handlePhaseWake } from "./wake";
export { ControlExecutor } from "./control-executor";
export { TransferExecutor } from "./transfer-executor";
export { MediaJobEvents } from "./media-job-events";
import { runVideoMaintenance } from "./video-runtime";
export { VideoGenerationWorkflowV1 } from "./video-generation-v1";
import {
	runMaintenance,
	runContinuation,
	runPolling,
	runTask,
	waitForDueTime,
	withTargetedEventDelivery,
	type DurableSteps,
} from "./orchestrator";

export interface WorkersEnvironment extends RuntimeExecutionEnvironment {
	/** Optional only for receiver-first rollout and historical local fixtures. */
	JOBS_CONTROL?: { fetch(request: Request): Promise<Response> };
	JOBS_TRANSFER?: { fetch(request: Request): Promise<Response> };
	JOBS_EXECUTOR: DurableObjectNamespace<WorkerJobs>;
}

export class WorkerJobs extends DurableObject<WorkersEnvironment> {
	private handler?: ReturnType<typeof createRuntimeExecutionHandler>;

	override async fetch(request: Request): Promise<Response> {
		// Legacy handlers also consume private video policy from these settings.
		hydrateVideoRuntimeEnvironment(this.env);
		if (new URL(request.url).pathname === "/internal/wake")
			return handleWake(
				request,
				this.env.WORKFLOWS_DISPATCH_SECRET,
				workerInvoker(this.env),
				(work) => this.ctx.waitUntil(work),
				createWakeContinuationScheduler(this.env.JOBS),
			);
		const lane = this.ctx.id.equals(
			this.env.JOBS_EXECUTOR.idFromName(WORKER_EXECUTORS.control.name),
		)
			? "control"
			: this.ctx.id.equals(this.env.JOBS_EXECUTOR.idFromName(WORKER_EXECUTORS.maintenance.name))
				? "maintenance"
				: "heavy";
		this.handler ??= createRuntimeExecutionHandler(this.env, {
			maxActive: WORKER_EXECUTORS[lane].maxActive,
			// The original object also accepts old Workflow deliveries. Keeping its
			// cap at one preserves the heavy limit while existing Workflows drain.
			acceptsTask: (task) => lane === "heavy" || workerExecutorLane(task) === lane,
			onEvent: (event) =>
				console.info("job.executor", { executor: WORKER_EXECUTORS[lane].name, ...event }),
		});
		const execution = this.handler(request);
		// Keep admitted work alive if its delivery connection is lost. Workflows
		// may retry delivery; PostgreSQL leases still decide who owns the work.
		this.ctx.waitUntil(execution.then(() => undefined));
		return execution;
	}
}

export class JobsWorkflow extends WorkflowEntrypoint<WorkersEnvironment, JobsParams> {
	override async run(event: WorkflowEvent<JobsParams>, step: WorkflowStep) {
		const invoke = workerInvoker(this.env);
		const steps = withTargetedEventDelivery(
			step as unknown as DurableSteps,
			event.payload.kind === "maintenance" ? undefined : event.payload.executionVersion,
		);
		if (event.payload.kind === "continuation" && event.payload.notBefore !== undefined)
			await waitForDueTime(steps, "wake-continuation-due", event.payload.notBefore);
		if (event.payload.kind === "maintenance")
			await runMaintenance(event.payload.timestamp, event.instanceId, steps, invoke);
		else if (event.payload.kind === "continuation")
			await runContinuation(event.payload.request, event.instanceId, steps, invoke);
		else if (
			["media-poll-generation", "media-verify-upload"].includes(event.payload.request.taskId)
		)
			await runPolling(event.payload.request, event.instanceId, steps, invoke);
		else await runTask(event.payload.request, event.instanceId, steps, invoke);
		return { completed: true };
	}
}

function workerInvoker(env: WorkersEnvironment) {
	const heavy = () =>
		env.JOBS_EXECUTOR.get(env.JOBS_EXECUTOR.idFromName(WORKER_EXECUTORS.heavy.name));
	return createExecutorInvoker(
		env.WORKFLOWS_DISPATCH_SECRET,
		(request) => {
			const service = workerServiceForTask(request);
			return service && env[service]
				? env[service]
				: env.JOBS_EXECUTOR.get(env.JOBS_EXECUTOR.idFromName(workerExecutorForTask(request).name));
		},
		(request) =>
			request.taskId === "media-finalize-generation" && env.JOBS_TRANSFER ? heavy() : undefined,
	);
}

export default {
	fetch(request, env) {
		if (isJobEventsRequest(request)) return handleJobEventsRequest(request, env);
		if (new URL(request.url).pathname === "/internal/phase-wake")
			return handlePhaseWake(request, env.WORKFLOWS_DISPATCH_SECRET, env.JOBS);
		if (new URL(request.url).pathname === "/internal/wake")
			return env.JOBS_EXECUTOR.get(
				env.JOBS_EXECUTOR.idFromName(WORKER_EXECUTORS.control.name),
			).fetch(request);
		return handleDispatch(request, env.WORKFLOWS_DISPATCH_SECRET, env.JOBS);
	},
	async scheduled(controller, env) {
		// Start direct recovery before awaiting legacy maintenance creation. It is
		// independent of the old maintenance DO's queue and of admission flags.
		const videoRecovery = runVideoMaintenance(env);
		const timestamp = Math.floor(controller.scheduledTime / 60_000) * 60_000;
		const results = await Promise.allSettled([
			videoRecovery,
			workflowInstanceId({ maintenance: timestamp }).then((id) =>
				env.JOBS.createBatch([
					{
						id,
						params: { kind: "maintenance", timestamp },
						retention: { successRetention: "1 day", errorRetention: "7 days" },
					},
				]),
			),
		]);
		if (results.some((result) => result.status === "rejected"))
			throw new Error("SCHEDULED_RECOVERY_FAILED");
	},
} satisfies ExportedHandler<WorkersEnvironment>;
