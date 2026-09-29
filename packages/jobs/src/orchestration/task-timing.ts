import type { TaskExecutionContext, TaskRequest } from "./contracts";

/** Called after capacity admission, including inline children sharing the parent slot. */
export function logTaskStarted(
	request: TaskRequest,
	context: TaskExecutionContext,
	startedAt = Date.now(),
): void {
	try {
		const { trace, payload } = request;
		const firstExecution = context.attempt === 1 && (trace?.pollTick ?? 0) === 0;
		console.info("media.task.started", {
			taskId: request.taskId,
			runId: context.runId,
			executionAttempt: context.attempt,
			...Object.fromEntries(
				["jobId", "attemptId", "assetId"].flatMap((key) =>
					typeof payload[key] === "string" ? [[key, payload[key]]] : [],
				),
			),
			...(trace?.requestId === undefined ? {} : { requestId: trace.requestId }),
			...(trace?.outboxEventId === undefined ? {} : { outboxEventId: trace.outboxEventId }),
			...(trace?.dueAt === undefined ? {} : { dueAt: trace.dueAt }),
			...(trace?.pollTick === undefined
				? {}
				: { pollTick: trace.pollTick, pollDueToStartMs: null }),
			startedAt,
			// The original event due time is not a due time for later polls or retries.
			dueToStartMs:
				!firstExecution || trace?.dueAt === undefined ? null : Math.max(0, startedAt - trace.dueAt),
		});
	} catch {
		// Diagnostics must never fail or replay business work.
	}
}
