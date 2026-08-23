import { schedules } from "@trigger.dev/sdk";

import { reconcileSubscriptions } from "../src/handlers/reconcile-subscriptions";

export const reconcileSubscriptionsTask = schedules.task({
	id: "media-reconcile-subscriptions",
	cron: "15 * * * *",
	queue: { name: "media-subscription-reconciliation", concurrencyLimit: 1 },
	maxDuration: 120,
	run: () => reconcileSubscriptions({ limit: 100 }),
});
