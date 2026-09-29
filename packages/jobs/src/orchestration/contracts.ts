export { OutboxDeliveryPendingError } from "../contracts";

export interface TaskRequest {
	taskId: string;
	payload: Record<string, unknown>;
	trace?: TaskTrace;
}

/** Diagnostics only: never part of dispatch identity or business decisions. */
export interface TaskTrace {
	requestId?: string;
	outboxEventId?: string;
	dueAt?: number;
	/** First poll is zero; later ticks must not reuse the event's due time. */
	pollTick?: number;
}

export interface TaskExecutionContext {
	attempt: number;
	maxAttempts: number;
	runId: string;
}

export interface TaskDefinition {
	maxAttempts: number;
	timeoutSeconds: number;
	queue: string;
	concurrency: number;
}

export interface PollingTickResult {
	done: boolean;
	waitSeconds: number;
	/** Absent on old executors. False means no committed forwardable event. */
	outboxCommitted?: boolean;
}

/** Only bounded control state may cross the private executor boundary. */
export function parsePollingTickResult(value: unknown): PollingTickResult {
	const result = value as Partial<PollingTickResult> | null;
	if (
		!result ||
		typeof result.done !== "boolean" ||
		typeof result.waitSeconds !== "number" ||
		!Number.isFinite(result.waitSeconds) ||
		(result.outboxCommitted !== undefined && typeof result.outboxCommitted !== "boolean") ||
		(result.done ? result.waitSeconds !== 0 : result.waitSeconds < 1 || result.waitSeconds > 60)
	)
		throw new Error("INVALID_POLL_RESULT");
	return {
		done: result.done,
		waitSeconds: result.waitSeconds,
		...(result.outboxCommitted === undefined ? {} : { outboxCommitted: result.outboxCommitted }),
	};
}
