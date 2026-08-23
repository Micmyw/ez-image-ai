import { task } from "@trigger.dev/sdk";

import { cancelProviderGeneration } from "../src/handlers/cancel-generation";
import {
	createProviderRegistry,
	databaseProviderCancellationStore,
	getRegisteredProvider,
} from "../src/runtime";

export const cancelProviderGenerationTask = task({
	id: "media-cancel-generation",
	queue: { name: "media-provider-cancellation", concurrencyLimit: 4 },
	maxDuration: 60,
	retry: { maxAttempts: 5, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000 },
	run: async (payload: { jobId: string; version: number }) => {
		const registry = createProviderRegistry(process.env, { includeRecoveryProviders: true });
		return cancelProviderGeneration(payload, {
			store: databaseProviderCancellationStore,
			getProvider: (provider) => getRegisteredProvider(registry, provider),
		});
	},
});
