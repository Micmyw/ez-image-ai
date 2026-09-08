import { Container, getContainer } from "@cloudflare/containers";
import { signRequest, workflowInstanceId } from "@repo/jobs/orchestration/auth";
import { taskDefinition } from "@repo/jobs/orchestration/registry";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { ContainerActivity } from "./activity";
import { handleDispatch, type JobsParams } from "./dispatch";
import {
	runMaintenance,
	runPolling,
	runTask,
	type DurableSteps,
	type InvokeTask,
	type InvocationResult,
} from "./orchestrator";

export class JobsContainer extends Container<Cloudflare.Env> {
	defaultPort = 8080;
	sleepAfter = "10s";
	enableInternet = true;
	envVars = runtimeEnvironment(this.env);
	private activity = new ContainerActivity();

	override async fetch(request: Request): Promise<Response> {
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
		const invoke: InvokeTask = async (request, context): Promise<InvocationResult> => {
			const body = JSON.stringify({ request, context });
			const response = await getContainer(this.env.JOBS_RUNTIME, "jobs-primary").fetch(
				new Request("http://runtime/internal/execute", {
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
		// Adapter narrows SDK duration template types while retaining actual durable
		// step methods. No timers or nested steps are hidden in callbacks.
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
} satisfies ExportedHandler<Cloudflare.Env>;
