import { task } from "@trigger.dev/sdk";

import { admitGuestGeneration } from "../src/handlers/admit-guest-generation";
import { databaseGuestAdmissionDependencies } from "../src/runtime";

export const admitGuestGenerationTask = task({
	id: "media-admit-guest-generation",
	queue: { name: "media-guest-admission", concurrencyLimit: 1 },
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: (payload: { jobId: string; trialId: string }) =>
		admitGuestGeneration(payload, databaseGuestAdmissionDependencies),
});
