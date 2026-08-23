import { task } from "@trigger.dev/sdk";

import { processPaymentEvent } from "../src/handlers/process-payment-event";

const PAYMENT_EVENT_MAX_ATTEMPTS = 8;

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
	retry: {
		maxAttempts: PAYMENT_EVENT_MAX_ATTEMPTS,
		factor: 2,
		minTimeoutInMs: 1_000,
		maxTimeoutInMs: 30_000,
		randomize: false,
	},
	run: async (payload: { paymentEventId: string }, { ctx }) =>
		runProcessPaymentEvent(payload, {
			attempt: ctx.attempt.number,
			maxAttempts: ctx.run.maxAttempts ?? PAYMENT_EVENT_MAX_ATTEMPTS,
			triggerRunId: ctx.run.id,
		}),
});
