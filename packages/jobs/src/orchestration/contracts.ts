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

export interface OutputReviewContinuation {
	waiting: boolean;
	eventIds: string[];
}

/** Only committed event identities cross the executor boundary, never provider data. */
export function parseOutputReviewContinuation(
	value: unknown,
): OutputReviewContinuation | undefined {
	const result = value as { outcome?: unknown; outputReviewEventIds?: unknown } | null;
	if (!result || result.outputReviewEventIds === undefined) return undefined;
	if (
		!Array.isArray(result.outputReviewEventIds) ||
		result.outputReviewEventIds.length > 100 ||
		result.outputReviewEventIds.some(
			(id) => typeof id !== "string" || !/^[a-zA-Z0-9_:-]{1,256}$/.test(id),
		) ||
		!["WAITING_MODERATION", "RETRY_SCHEDULED"].includes(String(result.outcome))
	)
		throw new Error("INVALID_OUTPUT_REVIEW_CONTINUATION");
	return {
		waiting: result.outcome === "WAITING_MODERATION",
		eventIds: [...new Set(result.outputReviewEventIds)],
	};
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
