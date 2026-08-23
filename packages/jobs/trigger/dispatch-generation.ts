import { task } from "@trigger.dev/sdk";

import { dispatchGeneration } from "../src/handlers/dispatch-generation";
import { dispatchRouteFor, parseMediaQueueLimits, providerQueueKey } from "../src/queues";
import {
	createProviderRegistry,
	databaseDispatchStore,
	getRegisteredProvider,
} from "../src/runtime";

const limits = parseMediaQueueLimits(process.env);

interface DispatchTaskPayload {
	jobId: string;
	version: number;
}

function runDispatch(payload: DispatchTaskPayload) {
	const registry = createProviderRegistry();
	return dispatchGeneration(payload, {
		store: databaseDispatchStore,
		getProvider: (provider) => getRegisteredProvider(registry, provider),
	});
}

function concurrency(provider: string, providerModelId: string, mediaKind: "image" | "video") {
	return (
		limits.models[providerQueueKey(provider, providerModelId)] ??
		limits.providers[provider] ??
		(mediaKind === "image" ? limits.imageSubmission : limits.videoSubmission)
	);
}

const replicateImage = dispatchRouteFor("image", "replicate", "black-forest-labs/flux-schnell");
export const dispatchReplicateImageTask = task({
	id: replicateImage.taskId,
	queue: {
		name: replicateImage.queueName,
		concurrencyLimit: concurrency("replicate", "black-forest-labs/flux-schnell", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: runDispatch,
});

const falImage = dispatchRouteFor("image", "fal", "fal-ai/flux/schnell");
export const dispatchFalImageTask = task({
	id: falImage.taskId,
	queue: {
		name: falImage.queueName,
		concurrencyLimit: concurrency("fal", "fal-ai/flux/schnell", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: runDispatch,
});

const geminiImage = dispatchRouteFor("image", "gemini", "gemini-2.5-flash-image");
export const dispatchGeminiImageTask = task({
	id: geminiImage.taskId,
	queue: {
		name: geminiImage.queueName,
		concurrencyLimit: concurrency("gemini", "gemini-2.5-flash-image", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: runDispatch,
});

const falVideo = dispatchRouteFor("video", "fal", "fal-ai/fast-video");
export const dispatchFalVideoTask = task({
	id: falVideo.taskId,
	queue: {
		name: falVideo.queueName,
		concurrencyLimit: concurrency("fal", "fal-ai/fast-video", "video"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: runDispatch,
});

const kieVideo = dispatchRouteFor("video", "kie", "veo3");
export const dispatchKieVideoTask = task({
	id: kieVideo.taskId,
	queue: {
		name: kieVideo.queueName,
		concurrencyLimit: concurrency("kie", "veo3", "video"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: runDispatch,
});
