import { task } from "@trigger.dev/sdk";

import { settleGeneration } from "../src/handlers/settle-generation";
import { QUEUE_NAMES, parseMediaQueueLimits } from "../src/queues";
import { databaseSettlementStore } from "../src/runtime";

const limits = parseMediaQueueLimits(process.env);

export const settleGenerationTask = task({
	id: "media-settle-generation",
	queue: { name: QUEUE_NAMES.settlementRecovery, concurrencyLimit: limits.settlementRecovery },
	maxDuration: 60,
	retry: { maxAttempts: 8, minTimeoutInMs: 1_000, maxTimeoutInMs: 60_000 },
	run: (payload: { jobId: string; version: number }) =>
		settleGeneration(payload, { store: databaseSettlementStore }),
});
