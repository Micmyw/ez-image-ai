import { readBoundedBody, verifyRequest, workflowInstanceId } from "@repo/jobs/orchestration/auth";
import { parseTaskContinuation, type TaskRequest } from "@repo/jobs/orchestration/contracts";
import { parseImagePhaseOwner, imagePhaseEventType } from "@repo/jobs/orchestration/contracts";
import { parseDatabaseConflictRetry } from "@repo/jobs/orchestration/execution-recovery";
import {
	parseEventDeliveryResult,
	parsePreparedEvent,
	parseTaskRequest,
	taskDefinition,
} from "@repo/jobs/orchestration/registry";

import type { WorkflowCreator } from "./dispatch";
import type { InvocationResult, InvokeTask } from "./orchestrator";

const MAX_FAST_CALLS = 128;
const FAST_WINDOW_MS = 25_000;
export type WakeContinuationScheduler = (
	request: TaskRequest,
	wakeId: string,
	notBefore?: number,
) => Promise<void>;

function isReadOnlyContinuation(request: TaskRequest): boolean {
	return (
		request.taskId === "media-poll-generation" ||
		(request.taskId === "media-verify-upload" && request.payload.queryOnly === true)
	);
}

export function createWakeContinuationScheduler(
	workflows: WorkflowCreator,
): WakeContinuationScheduler {
	return async (input, wakeId, notBefore) => {
		const request = parseTaskRequest(input);
		const readOnly = isReadOnlyContinuation(request);
		if (!readOnly && request.taskId !== "media-deliver-events" && !request.outboxReceipt)
			throw new Error("WAKE_CONTINUATION_RECEIPT_REQUIRED");
		if (notBefore !== undefined && (!Number.isSafeInteger(notBefore) || notBefore <= 0))
			throw new Error("INVALID_CONTINUATION_DUE_TIME");
		const identity =
			request.taskId === "media-poll-generation" ? request.payload.attemptId : wakeId;
		const id = await workflowInstanceId({
			wakeContinuation: identity,
			request: {
				taskId: request.taskId,
				payload: request.payload,
				...(request.outboxReceipt ? { outboxReceipt: request.outboxReceipt } : {}),
			},
			// A repeated review wake retains its original identity even when a
			// new clock sample changes the remaining wait. The due time is data.
			...(notBefore === undefined || request.taskId === "media-verify-upload" ? {} : { notBefore }),
		});
		await workflows.createBatch([
			{
				id,
				params: {
					kind: "continuation",
					request,
					...(notBefore === undefined ? {} : { notBefore }),
				},
				retention: { successRetention: "1 day", errorRetention: "7 days" },
			},
		]);
		const instance = await workflows.get(id);
		const { status } = await instance.status();
		if (["errored", "terminated"].includes(status) && readOnly) await instance.restart();
		else if (["errored", "terminated", "unknown", "paused", "waitingForPause"].includes(status))
			throw new Error("WAKE_CONTINUATION_UNAVAILABLE");
	};
}

/** A phase wake can only signal its persisted owner; it never starts another execution chain. */
export async function handlePhaseWake(
	request: Request,
	secret: string,
	workflows: WorkflowCreator,
): Promise<Response> {
	const url = new URL(request.url);
	if (request.method !== "POST" || url.pathname !== "/internal/phase-wake" || url.search)
		return new Response("Not found", { status: 404 });
	if (!secret || secret.length < 32) return new Response("Unavailable", { status: 503 });
	let body: string;
	try {
		body = await readBoundedBody(request);
	} catch {
		return new Response("Invalid body", { status: 413 });
	}
	if (!(await verifyRequest(secret, "POST", url.pathname, body, request.headers)))
		return new Response("Unauthorized", { status: 401 });
	let owner;
	try {
		const value = JSON.parse(body) as Record<string, unknown>;
		if (
			!value ||
			Object.keys(value).some(
				(key) => !["taskId", "payload", "idempotencyKey", "phaseOwner", "trace"].includes(key),
			) ||
			typeof value.idempotencyKey !== "string" ||
			!value.idempotencyKey ||
			value.idempotencyKey.length > 512
		)
			throw new Error("INVALID_PHASE_WAKE");
		const task = parseTaskRequest({
			taskId: value.taskId,
			payload: value.payload,
			...(value.trace === undefined ? {} : { trace: value.trace }),
		});
		if (
			!["media-verify-upload", "media-poll-generation"].includes(task.taskId) ||
			task.payload.allowQuarantinedReverification === true
		)
			throw new Error("INVALID_PHASE_WAKE");
		owner = parseImagePhaseOwner(value.phaseOwner);
	} catch {
		return new Response("Invalid phase wake", { status: 400 });
	}
	try {
		const instance = await workflows.get(owner.workflowId);
		if (!instance.sendEvent) throw new Error("PHASE_SIGNAL_UNAVAILABLE");
		await instance.sendEvent({
			type: imagePhaseEventType(owner),
			payload: { phaseKey: owner.phaseKey, epoch: owner.epoch },
		});
		return Response.json(
			{ accepted: true, wake: true, id: owner.workflowId, phaseOwner: owner },
			{ status: 202, headers: { "cache-control": "no-store" } },
		);
	} catch {
		return new Response("Phase signal unavailable", { status: 503 });
	}
}

/** A wake is only an acceleration of a previously committed due state. */
export async function handleWake(
	request: Request,
	secret: string,
	invoke: InvokeTask,
	defer: (work: Promise<void>) => void,
	resume: WakeContinuationScheduler,
): Promise<Response> {
	const url = new URL(request.url);
	if (request.method !== "POST" || url.pathname !== "/internal/wake" || url.search)
		return new Response("Not found", { status: 404 });
	if (!secret || secret.length < 32) return new Response("Unavailable", { status: 503 });
	let body: string;
	try {
		body = await readBoundedBody(request);
	} catch {
		return new Response("Invalid body", { status: 413 });
	}
	if (!(await verifyRequest(secret, "POST", url.pathname, body, request.headers)))
		return new Response("Unauthorized", { status: 401 });
	let task: TaskRequest;
	let id: string;
	try {
		const value = JSON.parse(body) as Record<string, unknown>;
		if (
			!value ||
			Object.keys(value).some(
				(key) => !["taskId", "payload", "idempotencyKey", "trace"].includes(key),
			) ||
			typeof value.idempotencyKey !== "string" ||
			!value.idempotencyKey ||
			value.idempotencyKey.length > 512
		)
			throw new Error("INVALID_WAKE");
		task = parseTaskRequest({
			taskId: value.taskId,
			payload: value.payload,
			...(value.trace === undefined ? {} : { trace: value.trace }),
		});
		if (
			!["media-verify-upload", "media-poll-generation"].includes(task.taskId) ||
			task.payload.allowQuarantinedReverification === true
		)
			throw new Error("INVALID_WAKE_TASK");
		id = await workflowInstanceId({
			idempotencyKey: value.idempotencyKey,
			task: { taskId: task.taskId, payload: task.payload },
		});
	} catch {
		return new Response("Invalid task", { status: 400 });
	}
	// No new durable execution is claimed here. The authenticated caller has
	// already committed its wake; leases, the original Workflow and Outbox own
	// recovery. waitUntil only lets this optional fast continuation finish.
	defer(
		runDirectWake(task, id, invoke, resume).catch(() => {
			console.warn("generation_direct_wake_deferred", { taskId: task.taskId, runId: id });
		}),
	);
	return Response.json(
		{ accepted: true, wake: true, id },
		{ status: 202, headers: { "cache-control": "no-store" } },
	);
}

/** Finite, no sleeps and no uncertain retries. Each child carries its DB receipt. */
export async function runDirectWake(
	request: TaskRequest,
	runId: string,
	invoke: InvokeTask,
	resume: WakeContinuationScheduler,
): Promise<void> {
	const deadline = Date.now() + FAST_WINDOW_MS;
	if (request.taskId === "media-verify-upload")
		request = { ...request, payload: { ...request.payload, queryOnly: true } };
	let calls = 0;
	const seen = new Set<string>();
	const pending: string[] = [];
	const call = async (task: TaskRequest): Promise<InvocationResult> => {
		if (Date.now() >= deadline || calls >= MAX_FAST_CALLS) return { status: "expired" };
		calls++;
		if (task.taskId === "media-finalize-generation")
			task = { ...task, payload: { ...task.payload, deferOutputReview: true } };
		let result: InvocationResult;
		try {
			result = await invoke(task, {
				attempt: 1,
				maxAttempts: taskDefinition(task.taskId).maxAttempts,
				runId,
			});
		} catch {
			// A lost transport response is not proof that paid work was rejected.
			// Only queries and receipt preparation may hand off an unknown outcome.
			return { status: "failed" };
		}
		if (result.status === "ok" && task.outboxReceipt) parseEventDeliveryResult(task, result);
		return result;
	};
	const collect = async (result: InvocationResult, task: TaskRequest) => {
		if (result.status === "retry" && parseDatabaseConflictRetry(task, result)) {
			// The receiver proved a rolled-back claim or settlement transaction.
			// Preserve the exact receipt and recover committed earlier work in a
			// durable task, never another direct retry loop.
			await resume(task, runId);
			return;
		}
		if (result.status === "busy" || result.status === "expired") {
			await resume(task, runId);
			return;
		}
		if (result.status === "failed" && isReadOnlyContinuation(task)) {
			await resume(task, runId);
			return;
		}
		if (result.status !== "ok" || result.deliveryState === "lost") return;
		if (result.poll?.done === false) {
			if (task.taskId === "media-verify-upload" && result.poll.queryOnly === true)
				task = { ...task, payload: { ...task.payload, queryOnly: true } };
			if (
				isReadOnlyContinuation(task) &&
				result.poll.retryImmediately === true &&
				result.poll.waitSeconds === 0
			) {
				// The previous successful query released its lease with new durable
				// evidence already due. Keep the same finite call/time budget.
				await collect(await call(task), task);
				return;
			}
			if (result.poll.retryImmediately === true) throw new Error("INVALID_IMMEDIATE_POLL");
			if (task.taskId === "media-verify-upload") {
				const seconds = result.poll.waitSeconds;
				if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60)
					throw new Error("INVALID_POLL_WAIT");
				// The receiver already returned the persisted due/lease remainder.
				// Start durable polling when due instead of immediately claiming again
				// just to rediscover that wait. Earlier callbacks still wake independently.
				await resume(task, runId, Date.now() + Math.ceil(seconds * 1_000));
			} else await resume(task, runId);
			return;
		}
		const continuation = parseTaskContinuation(result.continuation ?? result.poll?.continuation);
		if (continuation?.pollAttemptId)
			await resume(
				{ taskId: "media-poll-generation", payload: { attemptId: continuation.pollAttemptId } },
				runId,
			);
		// This wake may have won and ACKed a submit or transfer; the original
		// Workflow then cannot rediscover its processed event. Persist unfinished
		// read-only polling without replaying the successful paid handler.
		// A pending review's future due time must never become an immediate loop.
		if (
			continuation &&
			(continuation.notBefore === undefined || continuation.notBefore <= Date.now())
		) {
			for (const id of continuation.eventIds)
				if (!seen.has(id)) {
					seen.add(id);
					pending.push(id);
				}
		} else if (continuation?.eventIds.length) {
			await resume(
				{ taskId: "media-deliver-events", payload: { eventIds: continuation.eventIds } },
				runId,
				continuation.notBefore,
			);
		} else if (!continuation && result.outputReview) {
			for (const id of result.outputReview.eventIds)
				if (!seen.has(id)) {
					seen.add(id);
					pending.push(id);
				}
		}
	};
	await collect(await call(request), request);
	while (pending.length && Date.now() < deadline && calls < MAX_FAST_CALLS) {
		// Keep independent review/notification events concurrent without reserving
		// a heavy slot while preparing or waiting for another event.
		const batch = pending.splice(0, 4);
		const outcomes = await Promise.allSettled(
			batch.map(async (eventId) => {
				const prepareRequest = { taskId: "media-prepare-event", payload: { eventId } };
				const prepared = await call(prepareRequest);
				if (["busy", "expired", "failed"].includes(prepared.status)) {
					// Preparation cannot execute paid work. If its response was lost,
					// a new owner still waits for the old lease instead of stealing it.
					await resume({ taskId: "media-deliver-events", payload: { eventIds: [eventId] } }, runId);
					return;
				}
				if (prepared.status !== "ok") return;
				if (prepared.preparedEvent === undefined)
					throw new Error("EVENT_RECEIVER_UPGRADE_REQUIRED");
				const delivery = parseEventDeliveryResult(prepareRequest, prepared);
				if (delivery.eventRetryAfterMs !== undefined)
					throw new Error("EVENT_RETRY_CLOCK_NOT_NORMALIZED");
				const child = parsePreparedEvent(delivery.preparedEvent);
				if (!child) {
					if (delivery.eventRetryAt !== undefined)
						// The durable Workflow obtains a fresh DB remainder in its own
						// clock domain. A wake's wall clock never becomes its deadline.
						await resume(
							{ taskId: "media-deliver-events", payload: { eventIds: [eventId] } },
							runId,
						);
					return;
				}
				if (child.outboxReceipt?.eventId !== eventId) throw new Error("INVALID_PREPARED_EVENT");
				await collect(await call(child), child);
			}),
		);
		const failure = outcomes.find((outcome) => outcome.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	}
	while (pending.length)
		await resume(
			{ taskId: "media-deliver-events", payload: { eventIds: pending.splice(0, 100) } },
			runId,
		);
}
