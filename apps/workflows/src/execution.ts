import { readBoundedBody, verifyRequest } from "@repo/jobs/orchestration/auth";
import type {
	TaskRequest,
	TaskExecutionContext,
	PollingTickResult,
} from "@repo/jobs/orchestration/contracts";
import { parsePollingTickResult } from "@repo/jobs/orchestration/contracts";
import { parseTaskRequest, taskDefinition } from "@repo/jobs/orchestration/registry";

export interface WorkerExecutionOptions {
	secret: string;
	execute(request: TaskRequest, context: TaskExecutionContext): Promise<unknown>;
	poll(input: { attemptId: string }): Promise<PollingTickResult>;
	maxActive?: number;
	acceptsTask?(request: TaskRequest): boolean;
	onEvent?(event: {
		phase: "busy" | "completed";
		taskId: string;
		runId: string;
		active: number;
		maximum: number;
		elapsedMs?: number;
		outcome?: "ok" | "failed";
	}): void;
	env?: Record<string, string | undefined>;
}

export function createWorkerExecutionHandler(options: WorkerExecutionOptions) {
	if (options.secret.length < 32) throw new Error("INVALID_RUNTIME_SECRET");
	const maximum = options.maxActive ?? 4;
	if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16)
		throw new Error("INVALID_RUNTIME_CONCURRENCY");
	let active = 0;
	const queues = new Map<string, number>();
	const respond = (status: number, data: unknown) =>
		Response.json(data, { status, headers: { "cache-control": "no-store" } });
	const report = (event: Parameters<NonNullable<WorkerExecutionOptions["onEvent"]>>[0]) => {
		try {
			options.onEvent?.(event);
		} catch {
			// Observability must not turn completed work into a retry.
		}
	};
	return async (incoming: Request): Promise<Response> => {
		const url = new URL(incoming.url);
		if (incoming.method !== "POST" || url.pathname !== "/internal/execute" || url.search)
			return respond(404, { status: "not_found" });
		let body: string;
		try {
			body = await readBoundedBody(incoming);
			if (
				!(await verifyRequest(options.secret, "POST", "/internal/execute", body, incoming.headers))
			)
				return respond(401, { status: "unauthorized" });
		} catch {
			return respond(413, { status: "invalid_body" });
		}
		let request: TaskRequest;
		let context: TaskExecutionContext;
		let definition: ReturnType<typeof taskDefinition>;
		try {
			const value = JSON.parse(body);
			request = parseTaskRequest(value.request);
			if (options.acceptsTask && !options.acceptsTask(request))
				throw new Error("WRONG_TASK_EXECUTOR");
			definition = taskDefinition(request.taskId, options.env ?? process.env);
			context = value.context;
			if (
				!context ||
				!Number.isSafeInteger(context.attempt) ||
				context.attempt < 1 ||
				context.attempt > definition.maxAttempts ||
				context.maxAttempts !== definition.maxAttempts ||
				typeof context.runId !== "string" ||
				!context.runId.trim() ||
				context.runId.length > 256
			)
				throw new Error("INVALID_TASK_CONTEXT");
		} catch {
			return respond(400, { status: "invalid_task" });
		}
		const queued = queues.get(definition.queue) ?? 0;
		const identity = { taskId: request.taskId, runId: context.runId, maximum };
		if (active >= maximum || queued >= definition.concurrency) {
			report({ ...identity, phase: "busy", active });
			return respond(429, { status: "busy" });
		}
		active++;
		queues.set(definition.queue, queued + 1);
		const startedAt = Date.now();
		let outcome: "ok" | "failed" = "ok";
		try {
			// Deadlines belong to bounded I/O and Workflow delivery. Releasing this
			// slot on a raced timeout would allow abandoned execution to overlap.
			if (request.taskId === "media-poll-generation") {
				const poll = await options.poll({ attemptId: request.payload.attemptId as string });
				return respond(200, { status: "ok", poll });
			}
			const result = await options.execute(request, context);
			if (request.taskId === "media-verify-upload")
				return respond(200, { status: "ok", poll: parsePollingTickResult(result) });
			return respond(200, { status: "ok" });
		} catch {
			outcome = "failed";
			process.stderr.write(
				JSON.stringify({
					event: "job_execution_failed",
					taskId: request.taskId,
					runId: context.runId,
					attempt: context.attempt,
				}) + "\n",
			);
			return respond(502, { status: "failed" });
		} finally {
			active--;
			queues.set(definition.queue, (queues.get(definition.queue) ?? 1) - 1);
			report({
				...identity,
				phase: "completed",
				active,
				outcome,
				elapsedMs: Date.now() - startedAt,
			});
		}
	};
}
