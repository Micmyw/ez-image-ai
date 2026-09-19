export { OutboxDeliveryPendingError } from "../contracts";

export interface TaskRequest {
	taskId: string;
	payload: Record<string, unknown>;
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
}

/** Only bounded control state may cross the private executor boundary. */
export function parsePollingTickResult(value: unknown): PollingTickResult {
	const result = value as Partial<PollingTickResult> | null;
	if (
		!result ||
		typeof result.done !== "boolean" ||
		typeof result.waitSeconds !== "number" ||
		!Number.isFinite(result.waitSeconds) ||
		(result.done ? result.waitSeconds !== 0 : result.waitSeconds < 1 || result.waitSeconds > 60)
	)
		throw new Error("INVALID_POLL_RESULT");
	return { done: result.done, waitSeconds: result.waitSeconds };
}
