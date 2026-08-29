import { schedules } from "@trigger.dev/sdk";

import { reconcileGenerations } from "../src/handlers/reconcile-generations";
import {
	createReconciliationProviderRegistry,
	getAnyRegisteredProvider,
	databaseReconciliationStore,
} from "../src/runtime";

export const reconcileGenerationsTask = schedules.task({
	id: "media-reconcile-generations",
	cron: "*/5 * * * *",
	queue: { name: "media-reconciliation", concurrencyLimit: 1 },
	maxDuration: 240,
	run: async () => {
		const registry = createReconciliationProviderRegistry(process.env);
		return reconcileGenerations(
			{ limit: 25, leaseSeconds: 120 },
			{
				store: databaseReconciliationStore,
				getProvider: (provider) => getAnyRegisteredProvider(registry, provider),
			},
		);
	},
});
