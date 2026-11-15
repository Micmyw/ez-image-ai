import { dispatchJob } from "@repo/jobs/orchestration/client";
import { logger } from "@repo/logs";
import { getRequestDefer, type RequestDefer } from "@repo/utils/request-lifecycle";

/** Only call after the business transaction and its recovery intent have committed. */
export async function dispatchCommittedTask(
	taskId: string,
	payload: Record<string, unknown>,
	idempotencyKey: string,
	defer: RequestDefer | undefined = getRequestDefer(),
): Promise<void> {
	const delivery = dispatchJob(taskId, payload, { idempotencyKey, timeoutMs: 1000 }).then(
		() => undefined,
		() => {
			logger.warn("Committed task wake deferred to durable recovery", { taskId });
		},
	);
	if (defer) {
		try {
			defer(delivery);
			return;
		} catch {
			/* Drain the same delivery; never resubmit. */
		}
	}
	await delivery;
}
