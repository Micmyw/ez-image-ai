import type {
	TaskRequest,
	PollingTickResult,
	OutputReviewContinuation,
	TaskContinuation,
	OutboxExecutionState,
	TaskExecutionContext,
	ImagePhaseOwner,
} from "@repo/jobs/orchestration/contracts";
import {
	imagePhaseEventType,
	parseImagePhaseOwner,
	parseTaskContinuations,
} from "@repo/jobs/orchestration/contracts";
import {
	parseDatabaseConflictRetry,
	type DatabaseConflictRetry,
} from "@repo/jobs/orchestration/execution-recovery";
import {
	dispatchRouteForTask,
	parseEventDeliveryResult,
	parsePreparedEvent,
	maintenanceTasksAt,
	taskDefinition,
} from "@repo/jobs/orchestration/registry";

import { isVideoEventTimeout as isWorkflowEventTimeout } from "./video-orchestrator";

export interface DurableSteps {
	/** Opt-in only after receivers support private event receipts. Old adapters stay compatible. */
	targetedEventDelivery?: boolean;
	fusedEventDelivery?: boolean;
	phaseOwnership?: boolean;
	deferOutputReview?: boolean;
	do<T>(
		name: string,
		config: { retries: { limit: number; delay: string }; timeout: string },
		callback: () => Promise<T>,
	): Promise<T>;
	sleep(name: string, duration: string): Promise<void>;
	sleepUntil?(name: string, timestamp: Date | number): Promise<void>;
	waitForEvent?(name: string, options: { type: string; timeout: string }): Promise<unknown>;
}

/** Keep the stored deadline and sleep identity; an elapsed deadline needs no wait. */
export async function waitForDueTime(
	step: DurableSteps,
	name: string,
	dueAt: number,
): Promise<void> {
	const remaining = Math.ceil(dueAt - Date.now());
	if (remaining <= 0) return;
	if (step.sleepUntil) {
		try {
			await step.sleepUntil(name, dueAt);
		} catch (error) {
			// The binding may observe a later clock than this caller. Only this wait
			// is satisfied by elapsed time; no failed invocation is replayed here.
			if (Date.now() < dueAt) throw error;
		}
	} else await step.sleep(name, `${remaining} milliseconds`);
}

export function withTargetedEventDelivery(step: DurableSteps, executionVersion?: 2): DurableSteps {
	return {
		// WorkflowStep methods can be RPC proxies rather than native Functions.
		// Call through the original receiver; Function.bind is not an RPC method.
		do: (name, config, callback) => step.do(name, config, callback),
		sleep: (name, duration) => step.sleep(name, duration),
		...(step.sleepUntil
			? { sleepUntil: (name: string, at: Date | number) => step.sleepUntil!(name, at) }
			: {}),
		targetedEventDelivery: true,
		deferOutputReview: true,
		...(executionVersion === 2 ? { fusedEventDelivery: true, phaseOwnership: true } : {}),
		...(step.waitForEvent
			? {
					waitForEvent: (name: string, options: { type: string; timeout: string }) =>
						step.waitForEvent!(name, options),
				}
			: {}),
	};
}
export type InvocationResult =
	| {
			status: "ok";
			poll?: PollingTickResult;
			outputReview?: OutputReviewContinuation;
			continuation?: TaskContinuation;
			continuations?: TaskContinuation[];
			preparedEvent?: TaskRequest | null;
			executedEvent?: TaskRequest;
			eventRecoveryState?: "completed" | "held" | "missing";
			/** Workflow-local due time calculated from the database's remaining delay. */
			eventRetryAt?: number;
			deliveryState?: OutboxExecutionState;
	  }
	| { status: "busy"; capacityWaited?: boolean }
	| DatabaseConflictRetry
	| { status: "failed" | "expired" };
export type InvokeTask = (
	request: TaskRequest,
	context: TaskExecutionContext,
) => Promise<InvocationResult>;

/** A persisted fast-path handoff can start after its preparation lease expired. */
export async function runContinuation(
	request: TaskRequest,
	runId: string,
	step: DurableSteps,
	invoke: InvokeTask,
): Promise<void> {
	const result = ["media-verify-upload", "media-poll-generation"].includes(request.taskId)
		? await runPolling(request, runId, step, invoke)
		: await runTask(request, runId, step, invoke);
	if (result?.status === "ok" && result.deliveryState === "lost" && request.outboxReceipt)
		await runTask(
			{ taskId: "media-deliver-events", payload: { eventIds: [request.outboxReceipt.eventId] } },
			runId,
			step,
			invoke,
			"wake-reclaim",
		);
}

export async function runTask(
	request: TaskRequest,
	runId: string,
	step: DurableSteps,
	invoke: InvokeTask,
	prefix = request.taskId,
	deadline?: number,
	phaseOwner?: ImagePhaseOwner,
): Promise<(InvocationResult & { status: "ok" }) | { status: "expired" }> {
	if (step.deferOutputReview && request.taskId === "media-finalize-generation")
		request = { ...request, payload: { ...request.payload, deferOutputReview: true } };
	if (step.targetedEventDelivery && request.taskId === "media-deliver-events") {
		await runTargetedEvents(request, runId, step, invoke, prefix, deadline);
		return { status: "ok", continuation: { eventIds: [] } };
	}
	const definition = taskDefinition(request.taskId);
	for (let attempt = 1; attempt <= definition.maxAttempts; attempt++) {
		let retryImmediately = false;
		// Capacity is not an execution attempt. A bounded durable wait lets a
		// single-attempt submission wait for the Node runtime without resubmitting.
		for (let capacity = 0; capacity < 120; capacity++) {
			const name = `${prefix}-attempt-${attempt}-capacity-${capacity}`;
			const result = await step.do(
				name,
				{
					retries: { limit: 0, delay: "1 second" },
					timeout: `${definition.timeoutSeconds + 60} seconds`,
				},
				async (): Promise<InvocationResult> => {
					if (deadline !== undefined && Date.now() >= deadline) return { status: "expired" };
					try {
						return await invoke(request, {
							attempt,
							maxAttempts: definition.maxAttempts,
							runId,
							...(step.phaseOwnership
								? { workflowId: runId, ...(phaseOwner ? { phaseOwner } : {}) }
								: {}),
						});
					} catch {
						return { status: "failed" };
					}
				},
			);
			if (result.status === "ok") {
				if (request.taskId === "media-execute-event") parseEventDeliveryResult(request, result);
				// Receipt-aware execution must be explicit, including after a rolling upgrade.
				if (request.outboxReceipt) parseEventDeliveryResult(request, result);
				if (result.continuations !== undefined) {
					await runContinuationBatch(result.continuations, runId, step, invoke, prefix);
					return result;
				}
				const continuation = result.continuation ?? result.poll?.continuation;
				if (continuation) {
					await continueTask(continuation, runId, step, invoke, prefix);
					return result;
				}
				if (request.taskId === "media-finalize-generation" && result.outputReview) {
					for (const eventId of result.outputReview.eventIds) {
						try {
							// The heavy invocation has finished. The control executor claims this
							// exact committed event using the same lease/receipt path as recovery.
							await runTask(
								{ taskId: "media-deliver-output-review", payload: { eventId } },
								runId,
								step,
								invoke,
								`${prefix}-output-review-${eventId}`,
							);
						} catch {
							console.warn("output_review_delivery_deferred", { runId, outboxEventId: eventId });
						}
					}
				}
				if (shouldDeliverNextStage(request.taskId, result)) {
					try {
						// The previous invocation has released its executor slot and committed
						// its Outbox events. Delivery remains leased and completion-acknowledged.
						await runTask(
							{ taskId: "media-deliver-outbox", payload: {} },
							runId,
							step,
							invoke,
							`${prefix}-next-stage`,
						);
					} catch {
						// Never replay successful submission/verification because delivery failed.
						// The committed Outbox remains available to scheduled recovery.
						console.warn("immediate_outbox_delivery_deferred", { taskId: request.taskId, runId });
					}
				}
				return result;
			}
			if (result.status === "expired") return { status: "expired" };
			if (result.status === "busy") {
				if (capacity === 119) throw new Error("TASK_CAPACITY_TIMEOUT");
				if (!result.capacityWaited) await step.sleep(`${name}-wait`, "5 seconds");
				continue;
			}
			if (request.taskId === "media-execute-event" && request.payload.recoverOnly !== true) {
				// Transport failure may follow a paid effect. Only observe its durable completion.
				const recovered = await runTask(
					{ ...request, payload: { ...request.payload, recoverOnly: true } },
					runId,
					step,
					invoke,
					`${prefix}-recover`,
					deadline,
				);
				if (recovered.status === "ok" && recovered.eventRecoveryState === "completed")
					return recovered;
				throw new Error("TASK_RECOVERY_REQUIRED:media-execute-event");
			}
			if (result.status === "retry") {
				if (!parseDatabaseConflictRetry(request, result))
					throw new Error("INVALID_EXECUTION_RETRY");
				retryImmediately = true;
			} else if (
				request.outboxReceipt &&
				!(request.taskId === "media-verify-upload" && request.payload.queryOnly === true)
			) {
				// A failed/unknown response is not proof that receipt-bound work is
				// safe to repeat. Keep its lease and durable failure evidence intact.
				throw new Error(`TASK_RECOVERY_REQUIRED:${request.taskId}`);
			}
			break;
		}
		if (attempt < definition.maxAttempts && !retryImmediately)
			await step.sleep(`${prefix}-retry-${attempt}`, `${Math.min(30, 2 ** (attempt - 1))} seconds`);
	}
	throw new Error(`TASK_FAILED:${request.taskId}`);
}

async function continueTask(
	continuation: TaskContinuation,
	runId: string,
	step: DurableSteps,
	invoke: InvokeTask,
	prefix: string,
	serialEvents = false,
): Promise<void> {
	if (continuation.pollAttemptId) {
		// Acceptance is persisted. Poll only the original attempt after release.
		const result = await runPolling(
			{ taskId: "media-poll-generation", payload: { attemptId: continuation.pollAttemptId } },
			runId,
			step,
			invoke,
			`${prefix}-accepted-poll`,
			{ phaseOwner: continuation.phaseOwner },
		);
		if (result?.status !== "ok" || result.poll?.done !== true) return;
	}
	if (!continuation.eventIds.length) return;
	try {
		const notBefore = continuation.notBefore;
		if (notBefore !== undefined) {
			// Preserve absolute deadlines across cached invocation replay.
			await waitForDueTime(step, `${prefix}-continue-wait`, notBefore);
		}
		const groups = serialEvents ? continuation.eventIds.map((id) => [id]) : [continuation.eventIds];
		for (const [index, eventIds] of groups.entries())
			await runTask(
				{ taskId: "media-deliver-events", payload: { eventIds } },
				runId,
				step,
				invoke,
				serialEvents ? `${prefix}-continue-${index}` : `${prefix}-continue`,
			);
	} catch {
		console.warn("generation_continuation_deferred", { runId, eventIds: continuation.eventIds });
	}
}

async function runContinuationBatch(
	value: TaskContinuation[],
	runId: string,
	step: DurableSteps,
	invoke: InvokeTask,
	prefix: string,
): Promise<void> {
	const seen = new Set<string>();
	const work = parseTaskContinuations(value)!
		.flatMap((continuation) =>
			continuation.pollAttemptId
				? [continuation]
				: continuation.eventIds.map((id) => ({ ...continuation, eventIds: [id] })),
		)
		.filter((continuation) => {
			const identity = JSON.stringify(continuation);
			if (seen.has(identity)) return false;
			seen.add(identity);
			return true;
		});
	// Match targeted delivery's four independent branches without multiplying
	// its event batch width. A polling branch cannot block every ready callback.
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(4, work.length) }, async () => {
			while (next < work.length) {
				const index = next++;
				try {
					await continueTask(work[index]!, runId, step, invoke, `${prefix}-batch-${index}`, true);
				} catch {
					// This parent already committed. Preserve other branches and leave
					// the original attempt/events available to durable recovery.
					console.warn("outbox_continuation_deferred", { runId, continuationIndex: index });
				}
			}
		}),
	);
}

function shouldDeliverNextStage(
	taskId: string,
	result: InvocationResult & { status: "ok" },
): boolean {
	if (taskId === "media-finalize-generation" && result.outputReview?.waiting) return false;
	if (taskId === "media-poll-generation" || taskId === "media-verify-upload")
		return result.poll?.done === true && result.poll.outboxCommitted !== false;
	return (
		Boolean(dispatchRouteForTask(taskId)) ||
		[
			"media-admit-guest-generation",
			"media-process-provider-webhook",
			"media-finalize-generation",
			"media-cancel-generation",
			"media-settle-generation",
		].includes(taskId)
	);
}

export async function runPolling(
	request: TaskRequest,
	runId: string,
	step: DurableSteps,
	invoke: InvokeTask,
	prefix = "poll",
	options: { initialResult?: InvocationResult; phaseOwner?: ImagePhaseOwner } = {},
): Promise<InvocationResult | undefined> {
	let phaseOwner = options.phaseOwner;
	if (step.phaseOwnership && phaseOwner && phaseOwner.workflowId !== runId)
		return {
			status: "ok",
			poll: { done: false, waitSeconds: 60, phaseOwner, phaseOwnershipLost: true },
		};
	// Persist wall-clock decisions; replay must not extend the polling deadline.
	const deadline = await step.do(
		`${prefix}-deadline`,
		{ retries: { limit: 0, delay: "1 second" }, timeout: "5 seconds" },
		async () => Date.now() + 600_000,
	);
	for (let index = 0; index < 128; index++) {
		// V2 checks this same persisted deadline inside the execution step itself.
		// Keep historical budget step names for existing Workflow replay.
		const expired = step.fusedEventDelivery
			? false
			: await step.do(
					`${prefix}-budget-${index}`,
					{ retries: { limit: 0, delay: "1 second" }, timeout: "5 seconds" },
					async () => Date.now() >= deadline,
				);
		if (expired) return;
		const { dueAt, ...correlation } = request.trace ?? {};
		const tickRequest = {
			...request,
			trace: {
				...correlation,
				...(index === 0 && dueAt !== undefined ? { dueAt } : {}),
				pollTick: index,
			},
		};
		const result =
			index === 0 && options.initialResult
				? options.initialResult
				: await runTask(
						tickRequest,
						runId,
						step,
						invoke,
						`${prefix}-${index}`,
						deadline,
						phaseOwner,
					);
		if (result.status === "expired") return result;
		if (result.status !== "ok") throw new Error("INVALID_POLL_RESULT");
		if (!result.poll) throw new Error("INVALID_POLL_RESULT");
		if (result.poll.phaseOwner) phaseOwner = parseImagePhaseOwner(result.poll.phaseOwner);
		if (result.poll.phaseOwnershipLost === true) return result;
		if (result.poll.done) return result;
		// A shared input may already be owned by another live Workflow. It alone advances this phase.
		if (step.phaseOwnership && phaseOwner && phaseOwner.workflowId !== runId) return result;
		if (request.taskId === "media-verify-upload" && result.poll.queryOnly === true)
			request = { ...request, payload: { ...request.payload, queryOnly: true } };
		const seconds = result.poll.waitSeconds;
		if (
			seconds === 0 &&
			result.poll.retryImmediately === true &&
			(request.taskId === "media-poll-generation" ||
				(request.taskId === "media-verify-upload" && request.payload.queryOnly === true))
		)
			continue;
		if (result.poll.retryImmediately === true) throw new Error("INVALID_IMMEDIATE_POLL");
		if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60)
			throw new Error("INVALID_POLL_WAIT");
		if (step.phaseOwnership && phaseOwner && step.waitForEvent) {
			try {
				await step.waitForEvent(`${prefix}-phase-wait-${index}`, {
					type: imagePhaseEventType(phaseOwner),
					timeout: `${seconds} seconds`,
				});
			} catch (error) {
				// Timeouts are the durable recovery path for missing/early/lost signals.
				if (!isWorkflowEventTimeout(error, seconds * 1_000)) throw error;
			}
		} else await step.sleep(`${prefix}-wait-${index}`, `${seconds} seconds`);
	}
	// The scheduled reconciliation retains ownership beyond this bounded window.
}

async function runTargetedEvents(
	request: TaskRequest,
	runId: string,
	step: DurableSteps,
	invoke: InvokeTask,
	prefix: string,
	deadline?: number,
): Promise<void> {
	const ids = request.payload.eventIds;
	if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== "string"))
		throw new Error("INVALID_TARGETED_EVENTS");
	const deliver = async (index: number) => {
		let retryDeadline: number | undefined;
		deliveryLoop: for (let delivery = 0; delivery < 3; delivery++) {
			const childPrefix = `${prefix}-event-${index}-${delivery}`;
			let task: TaskRequest | null = null;
			for (let preparation = 0; preparation < 128; preparation++) {
				const prepareRequest = {
					taskId: step.fusedEventDelivery ? "media-execute-event" : "media-prepare-event",
					payload: { eventId: ids[index] },
					...(step.fusedEventDelivery ? { trace: { outboxEventId: ids[index] as string } } : {}),
				};
				// Retain the existing first step name for already persisted Workflows.
				const preparePrefix = `${childPrefix}-prepare${preparation ? `-due-${preparation}` : ""}`;
				const prepared = await runTask(
					prepareRequest,
					runId,
					step,
					invoke,
					preparePrefix,
					retryDeadline ?? deadline,
				);
				if (prepared.status === "expired") {
					if (retryDeadline !== undefined) throw new Error("EVENT_PREPARE_DEADLINE_EXCEEDED");
					return;
				}
				if (prepared.preparedEvent === undefined)
					throw new Error("EVENT_RECEIVER_UPGRADE_REQUIRED");
				const preparationResult = parseEventDeliveryResult(prepareRequest, prepared);
				if (preparationResult.eventRecoveryState === "held")
					throw new Error("TASK_RECOVERY_REQUIRED:media-execute-event");
				if (preparationResult.executedEvent) {
					const child = preparationResult.executedEvent;
					if (preparationResult.deliveryState === "lost") continue deliveryLoop;
					if (preparationResult.poll?.done === false) {
						const result = await runPolling(child, runId, step, invoke, `${childPrefix}-verify`, {
							initialResult: prepared,
						});
						if (result?.status === "expired") return;
						if (result?.status === "ok" && result.deliveryState === "lost") continue deliveryLoop;
					}
					return;
				}
				if (preparationResult.eventRetryAfterMs !== undefined)
					throw new Error("EVENT_RETRY_CLOCK_NOT_NORMALIZED");
				task = parsePreparedEvent(preparationResult.preparedEvent);
				if (task || preparationResult.eventRetryAt === undefined) break;
				if (preparation === 127) throw new Error("EVENT_PREPARE_RETRY_EXHAUSTED");
				// Covers the maximum 900-second execution lease plus grace, while
				// retaining a finite preparation window even if another owner renews it.
				retryDeadline ??= await step.do(
					`${prefix}-event-${index}-prepare-deadline`,
					{ retries: { limit: 0, delay: "1 second" }, timeout: "5 seconds" },
					async () => Math.min(deadline ?? Infinity, Date.now() + 960_000),
				);
				if (preparationResult.eventRetryAt > retryDeadline)
					throw new Error("EVENT_PREPARE_DEADLINE_EXCEEDED");
				// This is the committed due/lease remainder, not a fixed retry floor.
				// Waiting runs after the executor/DB scope has been released.
				await waitForDueTime(step, `${preparePrefix}-wait`, preparationResult.eventRetryAt);
			}
			if (!task) break;
			if (task.outboxReceipt?.eventId !== ids[index]) throw new Error("INVALID_PREPARED_EVENT");
			// The prepare invocation has finished and released its control slot.
			// Execute the child through normal lane admission; its receiver ACKs only
			// after durable completion, before the returned continuation starts.
			const result =
				task.taskId === "media-verify-upload"
					? await runPolling(task, runId, step, invoke, `${childPrefix}-verify`)
					: await runTask(task, runId, step, invoke, `${childPrefix}-execute`, deadline);
			if (result?.status === "expired") return;
			if (result?.status !== "ok" || result.deliveryState !== "lost") break;
			// A long capacity wait can outlive the prepared lease. Reclaim via a new
			// durable step; an expired token never executes or ACKs the child.
		}
	};
	// Independent input/output reviews must start together rather than each
	// waiting through its sibling's provider polls. Bound in-flight receipts;
	// Legacy buffered work retains capacity admission; request-owned control and
	// streaming execution have no shared count queue.
	let next = 0;
	const workers = await Promise.allSettled(
		Array.from({ length: Math.min(4, ids.length) }, async () => {
			while (next < ids.length) {
				const index = next++;
				await deliver(index);
			}
		}),
	);
	const failed = workers.find((worker) => worker.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
}

export async function runMaintenance(
	timestamp: number,
	runId: string,
	step: DurableSteps,
	invoke: InvokeTask,
): Promise<void> {
	let failed = false;
	// Workers serialize admission. Avoid starting competing maintenance calls
	// that repeatedly sleep for capacity and crowd out live generation stages.
	for (const taskId of maintenanceTasksAt(timestamp)) {
		try {
			await runTask({ taskId, payload: { timestamp } }, `${runId}:${taskId}`, step, invoke);
		} catch {
			failed = true;
		}
	}
	try {
		// Recovery may itself commit fresh events after the first Outbox pass.
		await runTask(
			{ taskId: "media-deliver-outbox", payload: {} },
			runId,
			step,
			invoke,
			"recovered-outbox",
		);
	} catch {
		failed = true;
	}
	if (failed) throw new Error("MAINTENANCE_FAILED");
}
