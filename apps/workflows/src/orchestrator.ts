import type { TaskRequest } from "@repo/jobs/orchestration/contracts";
import {
	dispatchRouteForTask,
	maintenanceTasksAt,
	taskDefinition,
} from "@repo/jobs/orchestration/registry";

export interface DurableSteps {
	do<T>(
		name: string,
		config: { retries: { limit: number; delay: string }; timeout: string },
		callback: () => Promise<T>,
	): Promise<T>;
	sleep(name: string, duration: string): Promise<void>;
}
export type InvocationResult =
	| { status: "ok"; poll?: { done: boolean; waitSeconds: number } }
	| { status: "busy" | "failed" | "expired" };
export type InvokeTask = (
	request: TaskRequest,
	context: { attempt: number; maxAttempts: number; runId: string },
) => Promise<InvocationResult>;

export async function runTask(
	request: TaskRequest,
	runId: string,
	step: DurableSteps,
	invoke: InvokeTask,
	prefix = request.taskId,
	deadline?: number,
): Promise<(InvocationResult & { status: "ok" }) | { status: "expired" }> {
	const definition = taskDefinition(request.taskId);
	for (let attempt = 1; attempt <= definition.maxAttempts; attempt++) {
		// Capacity is not an execution attempt. A bounded durable wait lets a
		// single-attempt submission wait for the Node runtime without resubmitting.
		for (let capacity = 0; capacity < 120; capacity++) {
			const name = `${prefix}-attempt-${attempt}-capacity-${capacity}`;
			const result = await step.do(
				name,
				{
					retries: { limit: 0, delay: "1 second" },
					timeout: `${definition.timeoutSeconds + 30} seconds`,
				},
				async (): Promise<InvocationResult> => {
					if (deadline !== undefined && Date.now() >= deadline) return { status: "expired" };
					try {
						return await invoke(request, { attempt, maxAttempts: definition.maxAttempts, runId });
					} catch {
						return { status: "failed" };
					}
				},
			);
			if (result.status === "ok") {
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
				await step.sleep(`${name}-wait`, "5 seconds");
				continue;
			}
			break;
		}
		if (attempt < definition.maxAttempts)
			await step.sleep(`${prefix}-retry-${attempt}`, `${Math.min(30, 2 ** (attempt - 1))} seconds`);
	}
	throw new Error(`TASK_FAILED:${request.taskId}`);
}

function shouldDeliverNextStage(
	taskId: string,
	result: InvocationResult & { status: "ok" },
): boolean {
	if (taskId === "media-poll-generation" || taskId === "media-verify-upload")
		return result.poll?.done === true;
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
): Promise<void> {
	// Persist wall-clock decisions; replay must not extend the polling deadline.
	const deadline = await step.do(
		"poll-deadline",
		{ retries: { limit: 0, delay: "1 second" }, timeout: "5 seconds" },
		async () => Date.now() + 600_000,
	);
	for (let index = 0; index < 128; index++) {
		const expired = await step.do(
			`poll-budget-${index}`,
			{ retries: { limit: 0, delay: "1 second" }, timeout: "5 seconds" },
			async () => Date.now() >= deadline,
		);
		if (expired) return;
		const result = await runTask(request, runId, step, invoke, `poll-${index}`, deadline);
		if (result.status === "expired") return;
		if (!result.poll) throw new Error("INVALID_POLL_RESULT");
		if (result.poll.done) return;
		const seconds = result.poll.waitSeconds;
		if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60)
			throw new Error("INVALID_POLL_WAIT");
		await step.sleep(`poll-wait-${index}`, `${seconds} seconds`);
	}
	// The scheduled reconciliation retains ownership beyond this bounded window.
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
