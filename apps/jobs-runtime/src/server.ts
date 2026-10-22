import { createServer } from "node:http";
import { Readable } from "node:stream";

import { readBoundedBody, verifyRequest } from "@repo/jobs/orchestration/auth";
import { ExecutionCapacity, parseCapacityWait } from "@repo/jobs/orchestration/capacity";
import type {
	TaskRequest,
	TaskExecutionContext,
	PollingTickResult,
} from "@repo/jobs/orchestration/contracts";
import {
	serializePollingTickResult,
	parseOutputReviewContinuation,
	parseTaskContinuation,
	parseTaskContinuations,
	parseImagePhaseOwner,
} from "@repo/jobs/orchestration/contracts";
import {
	executionFailureEvidence,
	databaseConflictRetryFor,
} from "@repo/jobs/orchestration/execution-recovery";
import {
	parseEventDeliveryResult,
	parseTaskRequest,
	taskDefinition,
} from "@repo/jobs/orchestration/registry";
import { logTaskStarted } from "@repo/jobs/orchestration/task-timing";

import { executionDeadline } from "./deadline";

export function createRuntimeServer(options: {
	secret: string;
	execute(request: TaskRequest, context: TaskExecutionContext): Promise<unknown>;
	poll(input: { attemptId: string }, context: TaskExecutionContext): Promise<PollingTickResult>;
	maxActive?: number;
	env?: Record<string, string | undefined>;
}) {
	if (options.secret.length < 32) throw new Error("INVALID_RUNTIME_SECRET");
	const maximum = options.maxActive ?? 4;
	if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16)
		throw new Error("INVALID_RUNTIME_CONCURRENCY");
	const capacity = new ExecutionCapacity(maximum);
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
			respond(200, { active: capacity.active });
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
		let waitForCapacityMs: number;
		let supportsImmediatePolling: boolean;
		let supportsDatabaseConflictRetry: boolean;
		try {
			const value = JSON.parse(body);
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				Object.keys(value).some(
					(key) =>
						![
							"request",
							"context",
							"waitForCapacityMs",
							"supportsImmediatePolling",
							"supportsDatabaseConflictRetry",
						].includes(key),
				)
			)
				throw new Error("INVALID_TASK_ENVELOPE");
			waitForCapacityMs = parseCapacityWait(value.waitForCapacityMs);
			supportsImmediatePolling = value.supportsImmediatePolling === true;
			supportsDatabaseConflictRetry = value.supportsDatabaseConflictRetry === true;
			request = parseTaskRequest(value.request);
			definition = taskDefinition(request.taskId, options.env ?? process.env);
			context = value.context;
			if (
				!context ||
				typeof context !== "object" ||
				Array.isArray(context) ||
				Object.keys(context).some(
					(key) => !["attempt", "maxAttempts", "runId", "workflowId", "phaseOwner"].includes(key),
				) ||
				!Number.isSafeInteger(context.attempt) ||
				context.attempt < 1 ||
				context.attempt > definition.maxAttempts ||
				context.maxAttempts !== definition.maxAttempts ||
				typeof context.runId !== "string" ||
				!context.runId.trim() ||
				context.runId.length > 256
			)
				throw new Error("INVALID_TASK_CONTEXT");
			if (context.workflowId !== undefined) {
				if (
					typeof context.workflowId !== "string" ||
					!/^[a-zA-Z0-9_-]{1,128}$/.test(context.workflowId) ||
					context.workflowId !== context.runId
				)
					throw new Error("INVALID_WORKFLOW_OWNER");
				if (context.phaseOwner !== undefined) {
					context.phaseOwner = parseImagePhaseOwner(context.phaseOwner);
					if (context.phaseOwner.workflowId !== context.workflowId)
						throw new Error("INVALID_WORKFLOW_OWNER");
				}
			} else if (context.phaseOwner !== undefined) throw new Error("INVALID_WORKFLOW_OWNER");
		} catch {
			respond(400, { status: "invalid_task" });
			return;
		}
		const waiting = new AbortController();
		const requestedAt = Date.now();
		const abortWait = () => waiting.abort();
		outgoing.once("close", abortWait);
		const admission = await capacity.acquire(definition, waitForCapacityMs, waiting.signal);
		outgoing.removeListener("close", abortWait);
		if (!admission.release) {
			respond(429, { status: "busy", ...(admission.waited ? { capacityWaited: true } : {}) });
			return;
		}
		const startedAt = Date.now();
		logTaskStarted(request, context, startedAt);
		let outcome = "ok";
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
				const poll = serializePollingTickResult(
					await options.poll({ attemptId: request.payload.attemptId as string }, context),
					supportsImmediatePolling,
					5,
				);
				respond(200, { status: "ok", poll });
			} else {
				const result = await options.execute(request, context);
				const delivery = parseEventDeliveryResult(request, result);
				const continuation = parseTaskContinuation(
					(result as { continuation?: unknown } | null)?.continuation,
				);
				const continuations = parseTaskContinuations(
					(result as { continuations?: unknown } | null)?.continuations,
				);
				const outputReview =
					request.taskId === "media-finalize-generation"
						? parseOutputReviewContinuation(result)
						: undefined;
				respond(
					200,
					request.taskId === "media-verify-upload"
						? {
								status: "ok",
								poll: serializePollingTickResult(result, supportsImmediatePolling, 1),
								...delivery,
							}
						: {
								status: "ok",
								...delivery,
								...(outputReview ? { outputReview } : {}),
								...(continuation ? { continuation } : {}),
								...(continuations ? { continuations } : {}),
							},
				);
			}
		} catch (error) {
			outcome = "failed";
			const retry = databaseConflictRetryFor(error, request, supportsDatabaseConflictRetry);
			process.stderr.write(
				JSON.stringify({
					event: "job_execution_failed",
					taskId: request.taskId,
					runId: context.runId,
					attempt: context.attempt,
					...executionFailureEvidence(error),
				}) + "\n",
			);
			respond(retry ? 503 : 502, retry ?? { status: "failed" });
		} finally {
			cancelDeadline();
			const completedAt = Date.now();
			admission.release();
			console.info("job.executor", {
				executor: "jobs-runtime",
				taskId: request.taskId,
				runId: context.runId,
				phase: "completed",
				active: capacity.active,
				maximum,
				outcome,
				startedAt,
				completedAt,
				elapsedMs: completedAt - startedAt,
				capacityWaitMs: startedAt - requestedAt,
			});
		}
	});
	server.requestTimeout = 30_000;
	server.headersTimeout = 10_000;
	server.keepAliveTimeout = 5_000;
	return server;
}
