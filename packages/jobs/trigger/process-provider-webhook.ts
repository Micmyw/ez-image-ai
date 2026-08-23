import { task } from "@trigger.dev/sdk";

import { processProviderEvent } from "../src/handlers/process-provider-event";
import {
	createProviderRegistry,
	databaseProviderEventStore,
	getRegisteredProvider,
} from "../src/runtime";

export const processProviderWebhookTask = task({
	id: "media-process-provider-webhook",
	queue: { name: "media-provider-events", concurrencyLimit: 10 },
	maxDuration: 60,
	retry: { maxAttempts: 5, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000 },
	run: async (payload: { providerWebhookEventId: string }) => {
		const registry = createProviderRegistry(process.env, { includeRecoveryProviders: true });
		return processProviderEvent(payload, {
			store: databaseProviderEventStore,
			getProvider: (provider) => getRegisteredProvider(registry, provider),
		});
	},
});
