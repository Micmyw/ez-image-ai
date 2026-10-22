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
	GenerationTransferRequiresHeavyError,
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

export interface WorkerExecutionOptions {
	secret: string;
	execute(request: TaskRequest, context: TaskExecutionContext): Promise<unknown>;
	poll(input: { attemptId: string }, context: TaskExecutionContext): Promise<PollingTickResult>;
	maxActive?: number;
	/** Independent service requests have no shared count-based admission queue. */
	admission?: "managed" | "request";
	streamingTransfersOnly?: boolean;
	acceptsTask?(request: TaskRequest): boolean;
	onEvent?(event: {
		phase: "busy" | "completed";
		taskId: string;
		runId: string;
		active: number;
		maximum: number | null;
		elapsedMs?: number;
		startedAt?: number;
		completedAt?: number;
		capacityWaitMs?: number;
		outcome?: "ok" | "failed" | "rerouted";
	}): void;
	env?: Record<string, string | undefined>;
}

export function createWorkerExecutionHandler(options: WorkerExecutionOptions) {
	if (options.secret.length < 32) throw new Error("INVALID_RUNTIME_SECRET");
	const maximum = options.admission === "request" ? null : (options.maxActive ?? 4);
	if (maximum !== null && (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16))
		throw new Error("INVALID_RUNTIME_CONCURRENCY");
	const capacity = maximum === null ? undefined : new ExecutionCapacity(maximum);
	let requestActive = 0;
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
				throw new Error("INVALID_EXECUTION_ENVELOPE");
			waitForCapacityMs = parseCapacityWait(value.waitForCapacityMs);
			supportsImmediatePolling = value.supportsImmediatePolling === true;
			supportsDatabaseConflictRetry = value.supportsDatabaseConflictRetry === true;
			request = parseTaskRequest(value.request);
			if (options.acceptsTask && !options.acceptsTask(request))
				throw new Error("WRONG_TASK_EXECUTOR");
			definition = taskDefinition(request.taskId, options.env ?? process.env);
			context = value.context;
			if (
				!context ||
				typeof context !== "object" ||
				Array.isArray(context) ||
				Object.keys(context).some(
					(key) => !["attempt", "maxAttempts", "runId", "workflowId", "phaseOwner"].includes(key),
				)
			)
				throw new Error("INVALID_TASK_CONTEXT");
			if (context?.workflowId !== undefined) {
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
			} else if (context?.phaseOwner !== undefined) throw new Error("INVALID_WORKFLOW_OWNER");
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
		const identity = { taskId: request.taskId, runId: context.runId, maximum };
		const requestedAt = Date.now();
		const admission = capacity
			? await capacity.acquire(definition, waitForCapacityMs, incoming.signal)
			: {
					release: () => {
						requestActive--;
					},
					waited: false,
				};
		const admittedAt = Date.now();
		if (!admission.release) {
			report({
				...identity,
				phase: "busy",
				active: capacity?.active ?? requestActive,
				capacityWaitMs: admittedAt - requestedAt,
			});
			return respond(429, {
				status: "busy",
				...(admission.waited ? { capacityWaited: true } : {}),
			});
		}
		const startedAt = admittedAt;
		if (!capacity) requestActive++;
		logTaskStarted(request, context, startedAt);
		let outcome: "ok" | "failed" | "rerouted" = "ok";
		try {
			// Deadlines belong to bounded I/O and Workflow delivery. Releasing this
			// slot on a raced timeout would allow abandoned execution to overlap.
			if (request.taskId === "media-poll-generation") {
				const poll = serializePollingTickResult(
					await options.poll({ attemptId: request.payload.attemptId as string }, context),
					supportsImmediatePolling,
					5,
				);
				return respond(200, { status: "ok", poll });
			}
			const result = await options.execute(request, context);
			const delivery = parseEventDeliveryResult(request, result);
			const continuation = parseTaskContinuation(
				(result as { continuation?: unknown } | null)?.continuation,
			);
			const continuations = parseTaskContinuations(
				(result as { continuations?: unknown } | null)?.continuations,
			);
			if (request.taskId === "media-verify-upload")
				return respond(200, {
					status: "ok",
					poll: serializePollingTickResult(result, supportsImmediatePolling, 1),
					...delivery,
				});
			if (request.taskId === "media-finalize-generation") {
				const outputReview = parseOutputReviewContinuation(result);
				return respond(200, {
					status: "ok",
					...delivery,
					...(outputReview ? { outputReview } : {}),
					...(continuation ? { continuation } : {}),
				});
			}
			return respond(200, {
				status: "ok",
				...delivery,
				...(continuation ? { continuation } : {}),
				...(continuations ? { continuations } : {}),
			});
		} catch (error) {
			if (
				options.streamingTransfersOnly &&
				request.taskId === "media-finalize-generation" &&
				error instanceof GenerationTransferRequiresHeavyError
			) {
				outcome = "rerouted";
				return respond(409, { status: "reroute", executor: "heavy" });
			}
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
			if (retry) return respond(503, retry);
			return respond(502, { status: "failed" });
		} finally {
			const completedAt = Date.now();
			admission.release();
			report({
				...identity,
				phase: "completed",
				active: capacity?.active ?? requestActive,
				outcome,
				startedAt,
				completedAt,
				capacityWaitMs: admittedAt - requestedAt,
				elapsedMs: completedAt - startedAt,
			});
		}
	};
}
