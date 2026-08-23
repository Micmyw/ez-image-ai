import { schedules, tasks } from "@trigger.dev/sdk";

import { deliverOutboxEvent } from "../src/handlers/deliver-outbox-event";
import { dispatchOutbox } from "../src/handlers/dispatch-outbox";
import { databaseOutboxStore, resolveDatabaseDispatchRoute } from "../src/runtime";

export const deliverOutboxTask = schedules.task({
	id: "media-deliver-outbox",
	cron: "* * * * *",
	queue: { name: "media-outbox", concurrencyLimit: 2 },
	maxDuration: 120,
	run: async () =>
		dispatchOutbox(
			{ workerId: `trigger:${crypto.randomUUID()}`, limit: 50, leaseSeconds: 90 },
			{
				store: databaseOutboxStore,
				deliver: (event) =>
					deliverOutboxEvent(event, {
						trigger: (taskId, payload) => tasks.trigger(taskId, payload).then(() => undefined),
						triggerAndWait: async (taskId, payload) => {
							const result = await tasks.triggerAndWait(taskId, payload);
							if (!result.ok) throw result.error;
						},
						resolveDispatchRoute: resolveDatabaseDispatchRoute,
					}),
			},
		),
});
