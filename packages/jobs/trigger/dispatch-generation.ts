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

const openRouterFastImage = requiredStaticDispatchRoute(
	"image",
	"openrouter",
	"sourceful/riverflow-v2.5-fast",
);
export const dispatchOpenRouterFastImageTask = task({
	id: openRouterFastImage.taskId,
	queue: {
		name: openRouterFastImage.queueName,
		concurrencyLimit: concurrency("openrouter", "sourceful/riverflow-v2.5-fast", "image"),
	},
	maxDuration: 300,
	retry: { maxAttempts: 1 },
	run: runDispatch(openRouterFastImage),
});

const openRouterQualityImage = requiredStaticDispatchRoute(
	"image",
	"openrouter",
	"sourceful/riverflow-v2.5-pro",
);
export const dispatchOpenRouterQualityImageTask = task({
	id: openRouterQualityImage.taskId,
	queue: {
		name: openRouterQualityImage.queueName,
		concurrencyLimit: concurrency("openrouter", "sourceful/riverflow-v2.5-pro", "image"),
	},
	maxDuration: 300,
	retry: { maxAttempts: 1 },
	run: runDispatch(openRouterQualityImage),
});

const kieNanoBanana2LiteImage = requiredStaticDispatchRoute("image", "kie", "nano-banana-2-lite");
export const dispatchKieNanoBanana2LiteImageTask = task({
	id: kieNanoBanana2LiteImage.taskId,
	queue: {
		name: kieNanoBanana2LiteImage.queueName,
		concurrencyLimit: concurrency("kie", "nano-banana-2-lite", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: runDispatch(kieNanoBanana2LiteImage),
});

const kieNanoBananaImage = requiredStaticDispatchRoute("image", "kie", "google/nano-banana-edit");
export const dispatchKieNanoBananaImageTask = task({
	id: kieNanoBananaImage.taskId,
	queue: {
		name: kieNanoBananaImage.queueName,
		concurrencyLimit: concurrency("kie", "google/nano-banana-edit", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: runDispatch(kieNanoBananaImage),
});

const kieNanoBanana2Image = requiredStaticDispatchRoute("image", "kie", "nano-banana-2");
export const dispatchKieNanoBanana2ImageTask = task({
	id: kieNanoBanana2Image.taskId,
	queue: {
		name: kieNanoBanana2Image.queueName,
		concurrencyLimit: concurrency("kie", "nano-banana-2", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: runDispatch(kieNanoBanana2Image),
});

const kieNanoBananaProImage = requiredStaticDispatchRoute("image", "kie", "nano-banana-pro");
export const dispatchKieNanoBananaProImageTask = task({
	id: kieNanoBananaProImage.taskId,
	queue: {
		name: kieNanoBananaProImage.queueName,
		concurrencyLimit: concurrency("kie", "nano-banana-pro", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: runDispatch(kieNanoBananaProImage),
});

const kieGptImage15Image = requiredStaticDispatchRoute(
	"image",
	"kie",
	"gpt-image/1.5-image-to-image",
);
export const dispatchKieGptImage15ImageTask = task({
	id: kieGptImage15Image.taskId,
	queue: {
		name: kieGptImage15Image.queueName,
		concurrencyLimit: concurrency("kie", "gpt-image/1.5-image-to-image", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: runDispatch(kieGptImage15Image),
});

const kieGptImage2Image = requiredStaticDispatchRoute("image", "kie", "gpt-image-2-image-to-image");
export const dispatchKieGptImage2ImageTask = task({
	id: kieGptImage2Image.taskId,
	queue: {
		name: kieGptImage2Image.queueName,
		concurrencyLimit: concurrency("kie", "gpt-image-2-image-to-image", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: runDispatch(kieGptImage2Image),
});

const kieSeedream45Image = requiredStaticDispatchRoute("image", "kie", "seedream/4.5-edit");
export const dispatchKieSeedream45ImageTask = task({
	id: kieSeedream45Image.taskId,
	queue: {
		name: kieSeedream45Image.queueName,
		concurrencyLimit: concurrency("kie", "seedream/4.5-edit", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: runDispatch(kieSeedream45Image),
});

const kieSeedream5LiteImage = requiredStaticDispatchRoute(
	"image",
	"kie",
	"seedream/5-lite-image-to-image",
);
export const dispatchKieSeedream5LiteImageTask = task({
	id: kieSeedream5LiteImage.taskId,
	queue: {
		name: kieSeedream5LiteImage.queueName,
		concurrencyLimit: concurrency("kie", "seedream/5-lite-image-to-image", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: runDispatch(kieSeedream5LiteImage),
});

const kieSeedream5ProImage = requiredStaticDispatchRoute(
	"image",
	"kie",
	"seedream/5-pro-image-to-image",
);
export const dispatchKieSeedream5ProImageTask = task({
	id: kieSeedream5ProImage.taskId,
	queue: {
		name: kieSeedream5ProImage.queueName,
		concurrencyLimit: concurrency("kie", "seedream/5-pro-image-to-image", "image"),
	},
	maxDuration: 60,
	retry: { maxAttempts: 1 },
	run: runDispatch(kieSeedream5ProImage),
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
	openRouterFastImage.taskId,
	openRouterQualityImage.taskId,
	kieNanoBanana2LiteImage.taskId,
	kieNanoBananaImage.taskId,
	kieNanoBanana2Image.taskId,
	kieNanoBananaProImage.taskId,
	kieGptImage15Image.taskId,
	kieGptImage2Image.taskId,
	kieSeedream45Image.taskId,
	kieSeedream5LiteImage.taskId,
	kieSeedream5ProImage.taskId,
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
