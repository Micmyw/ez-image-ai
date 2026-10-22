import type {
	beginWorkflowOutboxExecution,
	completeWorkflowOutboxExecution,
	deferWorkflowOutboxExecution,
	failWorkflowOutboxExecution,
	prepareWorkflowOutboxEvent,
} from "@repo/database";

import { GenerationTransferRequiresHeavyError } from "../contracts";
import {
	parsePollingTickResult,
	parseTaskContinuation,
	type TaskRequest,
	type TaskContinuation,
} from "../orchestration/contracts";
import { databaseConflictRetryFor } from "../orchestration/execution-recovery";
import {
	dispatchRouteForTask,
	parseTaskRequest,
	parseEventDeliveryResult,
	taskDefinition,
} from "../orchestration/registry";
import { outboxTaskTrace } from "../orchestration/task-timing";
import { workerExecutorLane } from "../orchestration/worker-executors";
import { deliverOutboxEvent } from "./deliver-outbox-event";

type Event = NonNullable<Awaited<ReturnType<typeof beginWorkflowOutboxExecution>>["event"]>;
type Resolution = Parameters<typeof deliverOutboxEvent>[1]["resolveDispatchRoute"];

async function recordRecoveryRequired(
	receipt: Parameters<typeof failWorkflowOutboxExecution>[0],
	fail: (input: Parameters<typeof failWorkflowOutboxExecution>[0]) => Promise<boolean>,
) {
	try {
		await fail(receipt);
	} catch {
		console.warn("outbox_recovery_marker_failed", { eventId: receipt.eventId });
	}
}

function recoveryRequired(cause?: unknown): Error {
	return Object.assign(new Error("OUTBOX_RECOVERY_REQUIRED", { cause }), {
		code: "OUTBOX_RECOVERY_REQUIRED",
	});
}

export async function prepareTargetedEvent(
	input: { eventId: string; workerId: string },
	dependencies: {
		prepare(
			input: Parameters<typeof prepareWorkflowOutboxEvent>[0],
		): ReturnType<typeof prepareWorkflowOutboxEvent>;
		resolve: Resolution;
		complete(input: { eventId: string; workerId: string; leaseToken: string }): Promise<boolean>;
	},
): Promise<TaskRequest | null> {
	const event = await dependencies.prepare(input);
	if (!event) return null;
	let request: TaskRequest | null = null;
	await deliverOutboxEvent(event, {
		resolveDispatchRoute: dependencies.resolve,
		trigger: async (taskId, payload) => {
			request = parseTaskRequest({
				taskId,
				payload,
				...outboxTaskTrace(event),
				outboxReceipt: {
					eventId: event.id,
					workerId: input.workerId,
					leaseToken: event.leaseToken,
				},
			});
		},
	});
	// A resolved no-op (for example an already terminal generation) has completed delivery.
	if (!request)
		await dependencies.complete({
			eventId: event.id,
			workerId: input.workerId,
			leaseToken: event.leaseToken,
		});
	return request;
}

/** One request scope for control work; durable waits and heavy admission remain outside it. */
export async function executeFusedTargetedEvent(
	input: { eventId: string; recoverOnly?: boolean },
	dependencies: {
		prepare(): Promise<{ preparedEvent: TaskRequest | null; eventRetryAfterMs?: number }>;
		execute(request: TaskRequest): Promise<unknown>;
		recover(): Promise<{
			eventRecoveryState: "completed" | "held" | "missing";
			continuation?: TaskContinuation;
		}>;
	},
): Promise<unknown> {
	if (input.recoverOnly) return { preparedEvent: null, ...(await dependencies.recover()) };
	const prepared = await dependencies.prepare();
	if (!prepared.preparedEvent) {
		if (prepared.eventRetryAfterMs !== undefined) return prepared;
		return { preparedEvent: null, ...(await dependencies.recover()) };
	}
	const child = parseTaskRequest(prepared.preparedEvent);
	if (child.outboxReceipt?.eventId !== input.eventId) throw new Error("INVALID_PREPARED_EVENT");
	// Never spend a control request on a transfer, buffered response or legacy reinspection.
	if (workerExecutorLane(child) !== "control") return { preparedEvent: child };
	let result: unknown;
	try {
		result = await dependencies.execute(child);
	} catch (error) {
		// The receipt handler released its guard only after a confirmed rollback.
		// Continue under the ordinary child retry budget, never replay the wrapper.
		if (databaseConflictRetryFor(error, child, true)) return { preparedEvent: child };
		throw error;
	}
	const delivery = parseEventDeliveryResult(child, result);
	const continuation = parseTaskContinuation(
		(result as { continuation?: unknown } | null)?.continuation,
	);
	return {
		preparedEvent: null,
		executedEvent: child,
		...delivery,
		...(child.taskId === "media-verify-upload" ? { poll: parsePollingTickResult(result) } : {}),
		...(continuation ? { continuation } : {}),
	};
}

export async function executeTargetedEvent(
	request: TaskRequest,
	dependencies: {
		begin(
			input: Parameters<typeof beginWorkflowOutboxExecution>[0],
		): ReturnType<typeof beginWorkflowOutboxExecution>;
		complete(
			input: Parameters<typeof completeWorkflowOutboxExecution>[0],
		): ReturnType<typeof completeWorkflowOutboxExecution>;
		fail(
			input: Parameters<typeof failWorkflowOutboxExecution>[0],
		): ReturnType<typeof failWorkflowOutboxExecution>;
		defer(
			input: Parameters<typeof deferWorkflowOutboxExecution>[0],
		): ReturnType<typeof deferWorkflowOutboxExecution>;
		execute(request: TaskRequest): Promise<unknown>;
		recover(request: TaskRequest): Promise<Record<string, unknown>>;
	},
): Promise<unknown> {
	const receipt = request.outboxReceipt;
	if (!receipt) throw new Error("OUTBOX_RECEIPT_REQUIRED");
	// A lost begin response never entered this handler. If it committed, its
	// execution guard already persists; do not downgrade another in-flight guard.
	const ownership = await dependencies.begin({
		...receipt,
		timeoutSeconds: taskDefinition(request.taskId).timeoutSeconds,
		...(request.taskId === "media-verify-upload" && request.payload.queryOnly === true
			? { allowQueryRecovery: true }
			: {}),
	});
	const lost = {
		done: true,
		waitSeconds: 0,
		outboxCommitted: false,
		continuation: { eventIds: [] },
		deliveryState: "lost" as const,
	};
	if (ownership.state === "lost" || !ownership.event) return lost;
	assertReceiptTask(ownership.event, request);
	if (ownership.state === "recovery-required") throw recoveryRequired();
	if (ownership.state === "completed") {
		// The prior handler may have committed and ACKed before its response was lost.
		// Recover durable control state only; never call the paid handler again.
		return { ...(await dependencies.recover(request)), deliveryState: "completed" };
	}
	const executionMarker = ownership.event.lastError;
	if (
		!executionMarker ||
		!/^(EXECUTION_IN_PROGRESS|RECOVERY_QUERY_IN_PROGRESS):[0-9a-f-]{36}$/.test(executionMarker)
	)
		throw new Error("INVALID_OUTBOX_EXECUTION_GUARD");
	const executionReceipt = { ...receipt, executionMarker };
	const { outboxReceipt: _receipt, ...task } = request;
	try {
		const result = await dependencies.execute(task);
		if (!result || typeof result !== "object" || Array.isArray(result))
			throw new Error("INVALID_OUTBOX_EXECUTION_RESULT");
		if ((result as { phaseOwnershipLost?: unknown }).phaseOwnershipLost === true) {
			if (!(await dependencies.defer(executionReceipt))) throw recoveryRequired();
			return { ...result, continuation: { eventIds: [] }, deliveryState: "pending" };
		}
		if (request.taskId === "media-verify-upload") {
			const { done } = result as { done?: unknown };
			if (typeof done !== "boolean") throw new Error("INVALID_OUTBOX_EXECUTION_RESULT");
			if (!done) {
				if (!(await dependencies.defer(executionReceipt))) throw recoveryRequired();
				return { ...result, deliveryState: "pending" };
			}
		}
		if (!(await dependencies.complete(executionReceipt))) return lost;
		return {
			...result,
			continuation: (result as { continuation?: unknown }).continuation ?? { eventIds: [] },
			deliveryState: "completed",
		};
	} catch (error) {
		if (
			databaseConflictRetryFor(error, request, true) ||
			(request.taskId === "media-finalize-generation" &&
				error instanceof GenerationTransferRequiresHeavyError)
		) {
			try {
				if (!(await dependencies.defer(executionReceipt))) throw recoveryRequired();
			} catch (deferError) {
				await recordRecoveryRequired(executionReceipt, (input) => dependencies.fail(input));
				throw recoveryRequired(deferError);
			}
		} else {
			await recordRecoveryRequired(executionReceipt, (input) => dependencies.fail(input));
		}
		throw error;
	}
}

/** A receipt cannot be attached to a different event target or a more privileged task. */
function assertReceiptTask(event: Event, request: TaskRequest): void {
	const payload =
		event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
			? (event.payload as Record<string, unknown>)
			: {};
	const target = request.payload;
	const invalid = () => {
		throw new Error("OUTBOX_RECEIPT_TASK_MISMATCH");
	};
	if (event.id !== request.outboxReceipt?.eventId) return invalid();
	if (
		event.aggregateType === "MEDIA_ASSET" &&
		["MEDIA_ASSET_VERIFY", "MEDIA_ASSET_MODERATION_REQUESTED"].includes(event.eventType)
	) {
		if (
			request.taskId !== "media-verify-upload" ||
			target.assetId !== event.aggregateId ||
			(payload.assetId !== undefined && payload.assetId !== event.aggregateId) ||
			(target.allowQuarantinedReverification === true) !==
				(payload.allowQuarantinedReverification === true)
		)
			return invalid();
		return;
	}
	if (
		event.aggregateType !== "GENERATION_JOB" ||
		target.jobId !== event.aggregateId ||
		(payload.jobId !== undefined && payload.jobId !== event.aggregateId) ||
		target.version !==
			(typeof payload.version === "number" && Number.isSafeInteger(payload.version)
				? payload.version
				: 0)
	)
		return invalid();
	if (["JOB_CREATED", "GENERATION_DISPATCH"].includes(event.eventType)) {
		if (dispatchRouteForTask(request.taskId)?.mediaKind !== "image") return invalid();
		return;
	}
	if (
		["GENERATION_FINALIZE", "GENERATION_FINALIZE_RETRY"].includes(event.eventType) &&
		request.taskId === "media-finalize-generation"
	)
		return;
	if (event.eventType === "GENERATION_SETTLE" && request.taskId === "media-settle-generation")
		return;
	return invalid();
}
