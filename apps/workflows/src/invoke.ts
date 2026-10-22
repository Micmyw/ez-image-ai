import { signRequest } from "@repo/jobs/orchestration/auth";
import { CAPACITY_WAIT_MS } from "@repo/jobs/orchestration/capacity";
import type { TaskRequest } from "@repo/jobs/orchestration/contracts";
import { parseDatabaseConflictRetry } from "@repo/jobs/orchestration/execution-recovery";
import { parseEventDeliveryResult, taskDefinition } from "@repo/jobs/orchestration/registry";

import type { InvocationResult, InvokeTask } from "./orchestrator";

/** Same bounded signed contract for Workflow and direct callback continuations. */
export function createExecutorInvoker(
	secret: string,
	executorFor: (request: TaskRequest) => { fetch(request: Request): Promise<Response> },
	heavyExecutorFor?: (
		request: TaskRequest,
	) => { fetch(request: Request): Promise<Response> } | undefined,
): InvokeTask {
	return async (request, context): Promise<InvocationResult> => {
		const body = JSON.stringify({
			request,
			context,
			waitForCapacityMs: CAPACITY_WAIT_MS,
			supportsImmediatePolling: true,
			supportsDatabaseConflictRetry: true,
		});
		const signed = async () =>
			new Request("https://executor/internal/execute", {
				method: "POST",
				body,
				headers: await signRequest(secret, "POST", "/internal/execute", body),
				signal: AbortSignal.timeout(
					(taskDefinition(request.taskId).timeoutSeconds + 10) * 1000 + CAPACITY_WAIT_MS,
				),
			});
		let response = await executorFor(request).fetch(await signed());
		if (response.status === 409 && request.taskId === "media-finalize-generation") {
			const result = (await response.json().catch(() => null)) as {
				status?: unknown;
				executor?: unknown;
			} | null;
			const heavy =
				result?.status === "reroute" && result.executor === "heavy"
					? heavyExecutorFor?.(request)
					: undefined;
			// Only an explicit no-buffer receiver decision may switch execution.
			// Transport failure or timeout never means that work was not accepted.
			if (!heavy) return { status: "failed" };
			response = await heavy.fetch(await signed());
		}
		if (response.status === 429) {
			// Legacy receivers (and a container starting up) may return plain text.
			const result = (await response.json().catch(() => null)) as {
				capacityWaited?: unknown;
			} | null;
			return {
				status: "busy",
				...(result?.capacityWaited === true ? { capacityWaited: true } : {}),
			};
		}
		if (response.status === 503) {
			const retry = parseDatabaseConflictRetry(request, await response.json().catch(() => null));
			return retry ?? { status: "failed" };
		}
		if (!response.ok) return { status: "failed" };
		const result = (await response.json()) as InvocationResult;
		if (result.status !== "ok") throw new Error("INVALID_RUNTIME_RESPONSE");
		if (["media-prepare-event", "media-execute-event"].includes(request.taskId)) {
			const delivery = parseEventDeliveryResult(request, result);
			if (delivery.eventRetryAfterMs !== undefined) {
				// The DB and a hybrid Node executor need not share the Workflow clock.
				// Convert here inside step.do, so replay retains this exact local due time.
				const { eventRetryAfterMs: _remaining, ...normalized } = result as typeof result & {
					eventRetryAfterMs?: number;
				};
				const eventRetryAt = Date.now() + delivery.eventRetryAfterMs;
				if (!Number.isSafeInteger(eventRetryAt)) throw new Error("INVALID_RUNTIME_RESPONSE");
				return { ...normalized, eventRetryAt };
			}
		}
		return result;
	};
}
