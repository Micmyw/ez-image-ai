import { createServer } from "node:http";
import { Readable } from "node:stream";

import { readBoundedBody, verifyRequest } from "@repo/jobs/orchestration/auth";
import type {
	TaskRequest,
	TaskExecutionContext,
	PollingTickResult,
} from "@repo/jobs/orchestration/contracts";
import { parseTaskRequest, taskDefinition } from "@repo/jobs/orchestration/registry";

import { executionDeadline } from "./deadline";

export function createRuntimeServer(options: {
	secret: string;
	execute(request: TaskRequest, context: TaskExecutionContext): Promise<unknown>;
	poll(input: { attemptId: string }): Promise<PollingTickResult>;
	maxActive?: number;
	env?: Record<string, string | undefined>;
}) {
	if (options.secret.length < 32) throw new Error("INVALID_RUNTIME_SECRET");
	const maximum = options.maxActive ?? 4;
	if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16)
		throw new Error("INVALID_RUNTIME_CONCURRENCY");
	let active = 0;
	const queues = new Map<string, number>();
	const server = createServer(async (incoming, outgoing) => {
		const respond = (status: number, data: unknown) => {
			if (outgoing.destroyed) return;
			outgoing.writeHead(status, {
				"content-type": "application/json",
				"cache-control": "no-store",
			});
			outgoing.end(JSON.stringify(data));
		};
		if (incoming.method === "GET" && incoming.url === "/health") {
			respond(200, { active });
			return;
		}
		if (incoming.method !== "POST" || incoming.url !== "/internal/execute") {
			respond(404, { status: "not_found" });
			return;
		}
		const headers = new Headers();
		for (const [key, value] of Object.entries(incoming.headers)) {
			if (typeof value === "string") headers.set(key, value);
		}
		let body: string;
		try {
			const init: RequestInit & { duplex: "half" } = {
				method: "POST",
				headers,
				body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
				duplex: "half",
			};
			body = await readBoundedBody(new Request("http://runtime/internal/execute", init));
			if (!(await verifyRequest(options.secret, "POST", "/internal/execute", body, headers))) {
				respond(401, { status: "unauthorized" });
				return;
			}
		} catch {
			respond(413, { status: "invalid_body" });
			return;
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
				!context.runId ||
				context.runId.length > 256
			)
				throw new Error();
		} catch {
			respond(400, { status: "invalid_task" });
			return;
		}
		const queued = queues.get(definition.queue) ?? 0;
		if (active >= maximum || queued >= definition.concurrency) {
			respond(429, { status: "busy" });
			return;
		}
		active++;
		queues.set(definition.queue, queued + 1);
		const cancelDeadline = executionDeadline(definition.timeoutSeconds + 15, () => {
			// All interrupted work stays recoverable via leases and pending Outbox
			// receipts. Do not keep an abandoned process alive after its deadline.
			process.stderr.write(
				JSON.stringify({ event: "job_deadline_exceeded", taskId: request.taskId }) + "\n",
			);
			process.exit(1);
		});
		try {
			// Only polling control state crosses back to Workflows. Never serialize
			// arbitrary handler results (provider data, prompts or media objects).
			if (request.taskId === "media-poll-generation") {
				const poll = await options.poll({ attemptId: request.payload.attemptId as string });
				respond(200, { status: "ok", poll });
			} else {
				await options.execute(request, context);
				respond(200, { status: "ok" });
			}
		} catch {
			process.stderr.write(
				JSON.stringify({
					event: "job_execution_failed",
					taskId: request.taskId,
					runId: context.runId,
					attempt: context.attempt,
				}) + "\n",
			);
			respond(502, { status: "failed" });
		} finally {
			cancelDeadline();
			active--;
			queues.set(definition.queue, (queues.get(definition.queue) ?? 1) - 1);
		}
	});
	server.requestTimeout = 30_000;
	server.headersTimeout = 10_000;
	server.keepAliveTimeout = 5_000;
	return server;
}
