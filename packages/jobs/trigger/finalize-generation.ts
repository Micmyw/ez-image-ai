import { task } from "@trigger.dev/sdk";

import { finalizeMedia } from "../src/handlers/finalize-media";
import { QUEUE_NAMES, parseMediaQueueLimits } from "../src/queues";
import { createFinalizationDependencies } from "../src/runtime";

const limits = parseMediaQueueLimits(process.env);

export const finalizeGenerationTask = task({
	id: "media-finalize-generation",
	queue: { name: QUEUE_NAMES.finalization, concurrencyLimit: limits.finalization },
	maxDuration: 900,
	retry: { maxAttempts: 5, minTimeoutInMs: 2_000, maxTimeoutInMs: 60_000 },
	run: (payload: { jobId: string; version: number }) =>
		finalizeMedia(payload, createFinalizationDependencies()),
});
