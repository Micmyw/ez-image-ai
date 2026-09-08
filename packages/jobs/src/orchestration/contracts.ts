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
