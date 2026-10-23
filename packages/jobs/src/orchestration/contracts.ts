export {
	OutboxDeliveryPendingError,
	GenerationTransferRequiresHeavyError,
	OutputTransferClaimConflictError,
	SettlementTransactionConflictError,
} from "../contracts";

export interface TaskRequest {
	taskId: string;
	payload: Record<string, unknown>;
	trace?: TaskTrace;
	/** Private v1 delivery fence. Old receivers reject this envelope instead of ignoring it. */
	outboxReceipt?: OutboxExecutionReceipt;
}

export interface OutboxExecutionReceipt {
	eventId: string;
	workerId: string;
	leaseToken: string;
}

export type OutboxExecutionState = "completed" | "pending" | "lost";

/** A durable phase owner, distinct from a short Outbox execution lease. */
export interface ImagePhaseOwner {
	workflowId: string;
	phaseKey: string;
	epoch: number;
}

export function parseImagePhaseOwner(value: unknown): ImagePhaseOwner {
	const owner = value as Partial<ImagePhaseOwner> | null;
	if (
		!owner ||
		typeof owner !== "object" ||
		Array.isArray(owner) ||
		Object.keys(owner).some((key) => !["workflowId", "phaseKey", "epoch"].includes(key)) ||
		![owner.workflowId, owner.phaseKey].every(
			(id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id),
		) ||
		!Number.isSafeInteger(owner.epoch) ||
		owner.epoch! < 1
	)
		throw new Error("INVALID_IMAGE_PHASE_OWNER");
	return { workflowId: owner.workflowId!, phaseKey: owner.phaseKey!, epoch: owner.epoch! };
}

export function imagePhaseEventType(value: ImagePhaseOwner): string {
	const owner = parseImagePhaseOwner(value);
	// Cloud bindings reject ':' even though local workerd accepts it. Keep
	// phase + epoch intact; truncation could signal a different phase owner.
	const type = `image-phase-${owner.phaseKey}-${owner.epoch}`;
	if (type.length > 100) throw new Error("INVALID_IMAGE_PHASE_EVENT_TYPE");
	return type;
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
	/** Only an actual durable Workflow supplies this; direct wake run IDs are not owners. */
	workflowId?: string;
	phaseOwner?: ImagePhaseOwner;
}

export interface TaskDefinition {
	maxAttempts: number;
	timeoutSeconds: number;
	queue: string;
	concurrency: number;
}

export interface PollingTickResult {
	phaseOwner?: ImagePhaseOwner;
	phaseOwnershipLost?: boolean;
	continuation?: TaskContinuation;
	/** A successful read released its lease with a newly due persisted query. */
	retryImmediately?: boolean;
	/** Receiver-confirmed bound image review; a later tick may never submit. */
	queryOnly?: boolean;
	done: boolean;
	waitSeconds: number;
	/** Absent on old executors. False means no committed forwardable event. */
	outboxCommitted?: boolean;
}

export interface TaskContinuation {
	eventIds: string[];
	pollAttemptId?: string;
	phaseOwner?: ImagePhaseOwner;
	/** Absolute epoch milliseconds at which the committed events become due. */
	notBefore?: number;
}

/** A present empty continuation deliberately suppresses legacy global scanning. */
export function parseTaskContinuation(value: unknown): TaskContinuation | undefined {
	if (value === undefined) return undefined;
	const next = value as Partial<TaskContinuation> | null;
	const validId = (id: unknown) => typeof id === "string" && /^[a-zA-Z0-9_:-]{1,256}$/.test(id);
	if (
		!next ||
		!Array.isArray(next.eventIds) ||
		next.eventIds.length > 100 ||
		next.eventIds.some((id) => !validId(id)) ||
		(next.pollAttemptId !== undefined && !validId(next.pollAttemptId)) ||
		(next.notBefore !== undefined && (!Number.isSafeInteger(next.notBefore) || next.notBefore <= 0))
	)
		throw new Error("INVALID_TASK_CONTINUATION");
	return {
		eventIds: [...new Set(next.eventIds)],
		...(next.pollAttemptId ? { pollAttemptId: next.pollAttemptId } : {}),
		...(next.phaseOwner === undefined ? {} : { phaseOwner: parseImagePhaseOwner(next.phaseOwner) }),
		...(next.notBefore !== undefined ? { notBefore: next.notBefore } : {}),
	};
}

/** One independent continuation per acknowledged item in a bounded Outbox batch. */
export function parseTaskContinuations(value: unknown): TaskContinuation[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > 100) throw new Error("INVALID_TASK_CONTINUATIONS");
	return value.map((item) => {
		const continuation = parseTaskContinuation(item);
		if (!continuation) throw new Error("INVALID_TASK_CONTINUATIONS");
		return continuation;
	});
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
		(result.queryOnly !== undefined && typeof result.queryOnly !== "boolean") ||
		(result.phaseOwnershipLost !== undefined && typeof result.phaseOwnershipLost !== "boolean") ||
		(result.phaseOwnershipLost === true && result.done) ||
		(result.retryImmediately !== undefined && typeof result.retryImmediately !== "boolean") ||
		(result.retryImmediately === true && (result.done || result.waitSeconds !== 0)) ||
		(result.done
			? result.waitSeconds !== 0
			: result.waitSeconds < (result.retryImmediately === true ? 0 : 1) || result.waitSeconds > 60)
	)
		throw new Error("INVALID_POLL_RESULT");
	return {
		done: result.done,
		...(result.phaseOwner === undefined
			? {}
			: { phaseOwner: parseImagePhaseOwner(result.phaseOwner) }),
		...(result.phaseOwnershipLost === undefined
			? {}
			: { phaseOwnershipLost: result.phaseOwnershipLost }),
		waitSeconds: result.waitSeconds,
		...(result.queryOnly === undefined ? {} : { queryOnly: result.queryOnly }),
		...(result.retryImmediately === undefined ? {} : { retryImmediately: result.retryImmediately }),
		...(result.continuation === undefined
			? {}
			: { continuation: parseTaskContinuation(result.continuation) }),
		...(result.outboxCommitted === undefined ? {} : { outboxCommitted: result.outboxCommitted }),
	};
}

/** Old Workflow instances cannot consume a pending response with zero delay. */
export function serializePollingTickResult(
	value: unknown,
	supportsImmediatePolling: boolean,
	legacyWaitSeconds: 1 | 5,
): PollingTickResult {
	const result = parsePollingTickResult(value);
	if (supportsImmediatePolling || result.retryImmediately !== true) return result;
	const compatible = { ...result, waitSeconds: legacyWaitSeconds };
	delete compatible.retryImmediately;
	return compatible;
}
