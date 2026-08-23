import { task } from "@trigger.dev/sdk";

import { processPaymentEvent } from "../src/handlers/process-payment-event";

export const processPaymentEventTask = task({
	id: "media-process-payment-event",
	queue: { name: "media-payment-events", concurrencyLimit: 5 },
	maxDuration: 60,
	retry: { maxAttempts: 5, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000 },
	run: processPaymentEvent,
});
