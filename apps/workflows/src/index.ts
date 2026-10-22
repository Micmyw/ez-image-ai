import { Container, getContainer } from "@cloudflare/containers";
import { workflowInstanceId } from "@repo/jobs/orchestration/auth";
import { workerServiceForTask } from "@repo/jobs/orchestration/worker-executors";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { ContainerActivity } from "./activity";
import { createExecutorInvoker } from "./invoke";
import { handleJobEventsRequest, isJobEventsRequest } from "./job-events";
import { createWakeContinuationScheduler, handleWake, handlePhaseWake } from "./wake";
export { ControlExecutor } from "./control-executor";
export { TransferExecutor } from "./transfer-executor";
export { MediaJobEvents } from "./media-job-events";
import { runVideoMaintenance, type VideoRuntimeEnvironment } from "./video-runtime";
export { VideoGenerationWorkflowV1 } from "./video-generation-v1";
import { handleDispatch, type JobsParams } from "./dispatch";
import {
	runMaintenance,
	runContinuation,
	runPolling,
	runTask,
	waitForDueTime,
	withTargetedEventDelivery,
	type DurableSteps,
} from "./orchestrator";

export class JobsContainer extends Container<Cloudflare.Env> {
	defaultPort = 8080;
	sleepAfter = "10s";
	enableInternet = true;
	envVars = runtimeEnvironment(this.env);
	private activity = new ContainerActivity();

	override async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname === "/internal/wake")
			return handleWake(
				request,
				this.env.WORKFLOWS_DISPATCH_SECRET,
				containerInvoker(this.env),
				(work) => this.ctx.waitUntil(work),
				createWakeContinuationScheduler(this.env.JOBS),
			);
		if (!this.activity.enter()) return new Response("Busy", { status: 429 });
		try {
			return await this.containerFetch(request);
		} finally {
			this.activity.leave();
			this.renewActivityTimeout();
		}
	}

	override async onActivityExpired(): Promise<void> {
		// The Container idle timer counts requests, not Node work. Check the Node
		// runtime because a long image transfer can outlive the incoming request.
		const stopped = await this.activity.stopIfIdle(
			async () => {
				const response = await this.containerFetch("http://runtime/health");
				const health = (await response.json()) as { active?: unknown };
				return response.ok && typeof health.active === "number" ? health.active : -1;
			},
			() => this.stop(),
		);
		if (!stopped) this.renewActivityTimeout();
	}
}

function runtimeEnvironment(env: Cloudflare.Env): Record<string, string> {
	let values: unknown;
	try {
		values = JSON.parse(env.JOBS_RUNTIME_ENV);
	} catch {
		throw new Error("INVALID_RUNTIME_ENV");
	}
	if (
		!values ||
		typeof values !== "object" ||
		Array.isArray(values) ||
		Object.entries(values).some(
			([key, value]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string",
		)
	)
		throw new Error("INVALID_RUNTIME_ENV");
	return {
		...(values as Record<string, string>),
		NODE_ENV: "production",
		PORT: "8080",
		WORKFLOWS_DISPATCH_URL: env.WORKFLOWS_DISPATCH_URL,
		WORKFLOWS_DISPATCH_SECRET: env.WORKFLOWS_DISPATCH_SECRET,
	};
}

export class JobsWorkflow extends WorkflowEntrypoint<Cloudflare.Env, JobsParams> {
	override async run(event: WorkflowEvent<JobsParams>, step: WorkflowStep) {
		const invoke = containerInvoker(this.env);
		// Adapter narrows SDK duration template types while retaining actual durable
		// step methods. No timers or nested steps are hidden in callbacks.
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

function containerInvoker(env: Cloudflare.Env) {
	return createExecutorInvoker(
		env.WORKFLOWS_DISPATCH_SECRET,
		(request) => {
			const service = workerServiceForTask(request);
			return service && env[service]
				? env[service]
				: getContainer(env.JOBS_RUNTIME, "jobs-primary");
		},
		(request) =>
			request.taskId === "media-finalize-generation" && env.JOBS_TRANSFER
				? getContainer(env.JOBS_RUNTIME, "jobs-primary")
				: undefined,
	);
}

export default {
	fetch(request, env) {
		if (isJobEventsRequest(request)) return handleJobEventsRequest(request, env);
		if (new URL(request.url).pathname === "/internal/phase-wake")
			return handlePhaseWake(request, env.WORKFLOWS_DISPATCH_SECRET, env.JOBS);
		if (new URL(request.url).pathname === "/internal/wake")
			return getContainer(env.JOBS_RUNTIME, "jobs-primary").fetch(request);
		return handleDispatch(request, env.WORKFLOWS_DISPATCH_SECRET, env.JOBS);
	},
	async scheduled(controller, env) {
		const videoRecovery = runVideoMaintenance(env as Cloudflare.Env & VideoRuntimeEnvironment);
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
} satisfies ExportedHandler<Cloudflare.Env>;
