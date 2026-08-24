import { schedules, task, tasks } from "@trigger.dev/sdk";

import {
	reconcileSubscriptions,
	type StripeReconciliationContinuation,
} from "../src/handlers/reconcile-subscriptions";

const CONTINUATION_TASK_ID = "media-reconcile-subscriptions-continuation";
const RECONCILIATION_RETRY = {
	maxAttempts: 5,
	factor: 2,
	minTimeoutInMs: 1_000,
	maxTimeoutInMs: 30_000,
	randomize: false,
} as const;

async function scheduleContinuation(continuation: StripeReconciliationContinuation): Promise<void> {
	await tasks.trigger(CONTINUATION_TASK_ID, continuation, {
		idempotencyKey: continuation.continuationKey,
	});
}

export const reconcileSubscriptionsContinuationTask = task({
	id: CONTINUATION_TASK_ID,
	queue: { name: "media-subscription-reconciliation", concurrencyLimit: 1 },
	maxDuration: 120,
	retry: RECONCILIATION_RETRY,
	run: (payload: StripeReconciliationContinuation) =>
		reconcileSubscriptions({
			limit: 100,
			expectedSweepId: payload.sweepId,
			continuationSequence: payload.sequence,
			scheduleContinuation,
		}),
});

export const reconcileSubscriptionsTask = schedules.task({
	id: "media-reconcile-subscriptions",
	cron: "15 * * * *",
	queue: { name: "media-subscription-reconciliation", concurrencyLimit: 1 },
	maxDuration: 120,
	retry: RECONCILIATION_RETRY,
	run: () => reconcileSubscriptions({ limit: 100, continuationSequence: 0, scheduleContinuation }),
});
