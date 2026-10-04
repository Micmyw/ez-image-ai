import type {
	listPendingVideoModerationEvents,
	markVideoModerationWebhookNotified,
	persistVideoModerationWebhook,
} from "@repo/database/video-v1-moderation-events";

import type { AcceptedWebhookResult, VideoWorkflowBinding } from "./contracts";

const RETIRED = "VIDEO_MODERATION_CALLBACK_RETIRED";
class RetiredModerationWebhookError extends Error {
	readonly status = 410;
	constructor() {
		super(RETIRED);
	}
}

/** Compatibility types only. Retired callbacks never read the body or use dependencies. */
export interface VideoModerationWebhookDependencies {
	binding?: VideoWorkflowBinding;
	environment?: Record<string, string | undefined>;
	persist?: typeof persistVideoModerationWebhook;
	markNotified?: typeof markVideoModerationWebhookNotified;
	now?: () => Date;
}

/** Sightengine is retired; historical configuration cannot re-enable this ingress. */
export async function acceptVideoModerationWebhook(
	_request: Request,
	_options: VideoModerationWebhookDependencies = {},
): Promise<AcceptedWebhookResult> {
	throw new RetiredModerationWebhookError();
}

export function createVideoModerationWebhookHandler(
	_options: VideoModerationWebhookDependencies = {},
) {
	return async (_request: Request): Promise<Response> =>
		Response.json({ code: RETIRED }, { status: 410 });
}

/** Retired recovery hook: do not scan old inboxes or wake legacy review work. */
export async function notifyPendingVideoModerationEvents(_options: {
	binding?: VideoWorkflowBinding;
	jobId?: string;
	limit?: number;
	events?: typeof listPendingVideoModerationEvents;
	markNotified?: typeof markVideoModerationWebhookNotified;
}) {
	return { notified: 0, failed: 0 };
}
