import type { ProviderKey } from "../types";

export interface StaticDispatchRoute {
	mediaKind: "image" | "video";
	provider: ProviderKey;
	providerModelId: string;
	taskId: string;
	queueName: string;
}

/**
 * Only these tuples have a registered execution task. Keep retired entries here until their
 * outstanding jobs have drained; new submission never fabricates a task identifier.
 */
export const STATIC_DISPATCH_ROUTE_MANIFEST = [
	{
		mediaKind: "image",
		provider: "replicate",
		providerModelId: "black-forest-labs/flux-schnell",
		taskId: "media-dispatch-image-replicate-black-forest-labs_flux-schnell",
		queueName: "media-image-replicate-black-forest-labs_flux-schnell",
	},
	{
		mediaKind: "image",
		provider: "fal",
		providerModelId: "fal-ai/flux/schnell",
		taskId: "media-dispatch-image-fal-fal-ai_flux-schnell",
		queueName: "media-image-fal-fal-ai_flux-schnell",
	},
	{
		mediaKind: "image",
		provider: "gemini",
		providerModelId: "gemini-2.5-flash-image",
		taskId: "media-dispatch-image-gemini-gemini-2.5-flash-image",
		queueName: "media-image-gemini-gemini-2.5-flash-image",
	},
	{
		mediaKind: "image",
		provider: "openrouter",
		providerModelId: "sourceful/riverflow-v2.5-fast",
		taskId: "media-dispatch-image-openrouter-sourceful_riverflow-v2.5-fast",
		queueName: "media-image-openrouter-sourceful_riverflow-v2.5-fast",
	},
	{
		mediaKind: "image",
		provider: "openrouter",
		providerModelId: "sourceful/riverflow-v2.5-pro",
		taskId: "media-dispatch-image-openrouter-sourceful_riverflow-v2.5-pro",
		queueName: "media-image-openrouter-sourceful_riverflow-v2.5-pro",
	},
	{
		mediaKind: "image",
		provider: "kie",
		providerModelId: "nano-banana-2-lite",
		taskId: "media-dispatch-image-kie-nano-banana-2-lite",
		queueName: "media-image-kie-nano-banana-2-lite",
	},
	{
		mediaKind: "image",
		provider: "kie",
		providerModelId: "google/nano-banana-edit",
		taskId: "media-dispatch-image-kie-google_nano-banana-edit",
		queueName: "media-image-kie-google_nano-banana-edit",
	},
	{
		mediaKind: "image",
		provider: "kie",
		providerModelId: "nano-banana-2",
		taskId: "media-dispatch-image-kie-nano-banana-2",
		queueName: "media-image-kie-nano-banana-2",
	},
	{
		mediaKind: "image",
		provider: "kie",
		providerModelId: "nano-banana-pro",
		taskId: "media-dispatch-image-kie-nano-banana-pro",
		queueName: "media-image-kie-nano-banana-pro",
	},
	{
		mediaKind: "image",
		provider: "kie",
		providerModelId: "gpt-image/1.5-image-to-image",
		taskId: "media-dispatch-image-kie-gpt-image_1.5-image-to-image",
		queueName: "media-image-kie-gpt-image_1.5-image-to-image",
	},
	{
		mediaKind: "image",
		provider: "kie",
		providerModelId: "gpt-image-2-image-to-image",
		taskId: "media-dispatch-image-kie-gpt-image-2-image-to-image",
		queueName: "media-image-kie-gpt-image-2-image-to-image",
	},
	{
		mediaKind: "image",
		provider: "kie",
		providerModelId: "seedream/4.5-edit",
		taskId: "media-dispatch-image-kie-seedream_4.5-edit",
		queueName: "media-image-kie-seedream_4.5-edit",
	},
	{
		mediaKind: "image",
		provider: "kie",
		providerModelId: "seedream/5-lite-image-to-image",
		taskId: "media-dispatch-image-kie-seedream_5-lite-image-to-image",
		queueName: "media-image-kie-seedream_5-lite-image-to-image",
	},
	{
		mediaKind: "image",
		provider: "kie",
		providerModelId: "seedream/5-pro-image-to-image",
		taskId: "media-dispatch-image-kie-seedream_5-pro-image-to-image",
		queueName: "media-image-kie-seedream_5-pro-image-to-image",
	},
	{
		mediaKind: "video",
		provider: "fal",
		providerModelId: "fal-ai/fast-video",
		taskId: "media-dispatch-video-fal-fal-ai_fast-video",
		queueName: "media-video-fal-fal-ai_fast-video",
	},
	{
		mediaKind: "video",
		provider: "kie",
		providerModelId: "veo3",
		taskId: "media-dispatch-video-kie-veo3",
		queueName: "media-video-kie-veo3",
	},
] as const satisfies readonly StaticDispatchRoute[];

const staticDispatchRoutes = new Map(
	STATIC_DISPATCH_ROUTE_MANIFEST.map((route) => [dispatchRouteKey(route), route]),
);

if (staticDispatchRoutes.size !== STATIC_DISPATCH_ROUTE_MANIFEST.length) {
	throw new Error("Static dispatch route manifest has duplicate tuples");
}
if (
	new Set(STATIC_DISPATCH_ROUTE_MANIFEST.map((route) => route.taskId)).size !==
	staticDispatchRoutes.size
) {
	throw new Error("Static dispatch route manifest has duplicate task IDs");
}

export function staticDispatchRouteFor(
	mediaKind: "image" | "video",
	provider: ProviderKey,
	providerModelId: string,
): StaticDispatchRoute | undefined {
	return staticDispatchRoutes.get(dispatchRouteKey({ mediaKind, provider, providerModelId }));
}

function dispatchRouteKey(input: {
	mediaKind: "image" | "video";
	provider: ProviderKey;
	providerModelId: string;
}): string {
	return `${input.mediaKind}:${input.provider}:${input.providerModelId}`;
}
