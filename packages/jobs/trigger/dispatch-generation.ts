import { staticDispatchRouteFor, type ProviderKey, type StaticDispatchRoute } from "@repo/ai";
import { db } from "@repo/database/client";
import { task } from "@trigger.dev/sdk";

import { dispatchGeneration } from "../src/handlers/dispatch-generation";
import { parseMediaQueueLimits, providerQueueKey } from "../src/queues";
import {
	createProviderRegistry,
	createDatabaseDispatchStore,
	getRegisteredProvider,
} from "../src/runtime";

const limits = parseMediaQueueLimits(process.env);

interface DispatchTaskPayload {
	jobId: string;
	version: number;
	provider?: ProviderKey;
	providerModelId?: string;
}

function runDispatch(route: StaticDispatchRoute) {
	return (payload: DispatchTaskPayload) => {
		const registry = createProviderRegistry();
		return dispatchGeneration(
			{
				...payload,
				provider: payload.provider ?? route.provider,
				providerModelId: payload.providerModelId ?? route.providerModelId,
			},
			{
				store: createDatabaseDispatchStore(db, { enabledProviders: new Set(registry.keys()) }),
				getProvider: (provider) => getRegisteredProvider(registry, provider),
			},
		);
	};
}

function concurrency(provider: string, providerModelId: string, mediaKind: "image" | "video") {
	return (
		limits.models[providerQueueKey(provider, providerModelId)] ??
		limits.providers[provider] ??
		(mediaKind === "image" ? limits.imageSubmission : limits.videoSubmission)
	);
}

const replicateImage = requiredStaticDispatchRoute(
	"image",
	"replicate",
	"black-forest-labs/flux-schnell",
);
export const dispatchReplicateImageTask = task({
	id: replicateImage.taskId,
	queue: {
		name: replicateImage.queueName,
		concurrencyLimit: concurrency("replicate", "black-forest-labs/flux-schnell", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 5, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000 },
	run: runDispatch(replicateImage),
});

const falImage = requiredStaticDispatchRoute("image", "fal", "fal-ai/flux/schnell");
export const dispatchFalImageTask = task({
	id: falImage.taskId,
	queue: {
		name: falImage.queueName,
		concurrencyLimit: concurrency("fal", "fal-ai/flux/schnell", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 5, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000 },
	run: runDispatch(falImage),
});

const geminiImage = requiredStaticDispatchRoute("image", "gemini", "gemini-2.5-flash-image");
export const dispatchGeminiImageTask = task({
	id: geminiImage.taskId,
	queue: {
		name: geminiImage.queueName,
		concurrencyLimit: concurrency("gemini", "gemini-2.5-flash-image", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 5, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000 },
	run: runDispatch(geminiImage),
});

const falVideo = requiredStaticDispatchRoute("video", "fal", "fal-ai/fast-video");
export const dispatchFalVideoTask = task({
	id: falVideo.taskId,
	queue: {
		name: falVideo.queueName,
		concurrencyLimit: concurrency("fal", "fal-ai/fast-video", "video"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 5, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000 },
	run: runDispatch(falVideo),
});

const kieVideo = requiredStaticDispatchRoute("video", "kie", "veo3");
export const dispatchKieVideoTask = task({
	id: kieVideo.taskId,
	queue: {
		name: kieVideo.queueName,
		concurrencyLimit: concurrency("kie", "veo3", "video"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 5, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000 },
	run: runDispatch(kieVideo),
});

export const declaredDispatchTaskIds = [
	replicateImage.taskId,
	falImage.taskId,
	geminiImage.taskId,
	falVideo.taskId,
	kieVideo.taskId,
] as const;

function requiredStaticDispatchRoute(
	mediaKind: "image" | "video",
	provider: ProviderKey,
	providerModelId: string,
): StaticDispatchRoute {
	const route = staticDispatchRouteFor(mediaKind, provider, providerModelId);
	if (!route) throw new Error("UNDECLARED_DISPATCH_ROUTE");
	return route;
}
