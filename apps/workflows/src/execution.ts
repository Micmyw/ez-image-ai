import { readBoundedBody, verifyRequest } from "@repo/jobs/orchestration/auth";
import type {
	TaskRequest,
	TaskExecutionContext,
	PollingTickResult,
} from "@repo/jobs/orchestration/contracts";
import { parseTaskRequest, taskDefinition } from "@repo/jobs/orchestration/registry";

export interface WorkerExecutionOptions {
	secret: string;
	execute(request: TaskRequest, context: TaskExecutionContext): Promise<unknown>;
	poll(input: { attemptId: string }): Promise<PollingTickResult>;
	maxActive?: number;
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
		if (active >= maximum || queued >= definition.concurrency)
			return respond(429, { status: "busy" });
		active++;
		queues.set(definition.queue, queued + 1);
		try {
			// Deadlines belong to bounded I/O and Workflow delivery. Releasing this
			// slot on a raced timeout would allow abandoned execution to overlap.
			if (request.taskId === "media-poll-generation") {
				const poll = await options.poll({ attemptId: request.payload.attemptId as string });
				return respond(200, { status: "ok", poll });
			}
			await options.execute(request, context);
			return respond(200, { status: "ok" });
		} catch {
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
		}
	};
}
