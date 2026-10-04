import {
	markVideoTemplateSceneWebhookNotified,
	persistVideoTemplateSceneWebhook,
} from "@repo/database/video-template-execution";

import {
	acceptVideoProviderWebhook,
	createVideoProviderWebhookHandler,
	type VideoWebhookDependencies,
} from "./webhooks";

/** Reuse strict bounded HMAC verification, with a separate sidecar inbox namespace.
 * No scene callback can bind a final-video attempt or authorize a result URL.
 */
const defaults: Pick<VideoWebhookDependencies, "persist" | "markNotified"> = {
	persist: async (input) => {
		try {
			return await persistVideoTemplateSceneWebhook(input);
		} catch (error) {
			if (
				error instanceof Error &&
				/^(VIDEO_TEMPLATE_.*(?:INVALID|CONFLICT|NOT_FOUND)|VIDEO_CALLBACK_)/.test(error.message)
			)
				throw new Error("VIDEO_CALLBACK_ATTEMPT_INVALID");
			throw error;
		}
	},
	markNotified: markVideoTemplateSceneWebhookNotified,
};

export function acceptVideoTemplateProviderWebhook(
	request: Request,
	options: VideoWebhookDependencies = {},
) {
	return acceptVideoProviderWebhook(request, { ...defaults, ...options });
}
export function createVideoTemplateProviderWebhookHandler(options: VideoWebhookDependencies = {}) {
	return createVideoProviderWebhookHandler({ ...defaults, ...options });
}
