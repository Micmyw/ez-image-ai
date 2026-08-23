import { task } from "@trigger.dev/sdk";

import { processPaymentEvent } from "../src/handlers/process-payment-event";

export async function runProcessPaymentEvent(
	payload: { paymentEventId: string },
	context: { attempt: number; maxAttempts: number; triggerRunId: string },
) {
	return processPaymentEvent(payload, context);
}

export const processPaymentEventTask = task({
	id: "media-process-payment-event",
	queue: { name: "media-payment-events", concurrencyLimit: 5 },
	maxDuration: 60,
	retry: { maxAttempts: 5, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000 },
	run: async (payload: { paymentEventId: string }, { ctx }) =>
		runProcessPaymentEvent(payload, {
			attempt: ctx.attempt.number,
			maxAttempts: ctx.run.maxAttempts ?? 5,
			triggerRunId: ctx.run.id,
		}),
});
