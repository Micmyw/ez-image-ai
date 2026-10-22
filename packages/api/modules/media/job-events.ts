import { auth } from "@repo/auth";
import { ownsMediaJobSubscription } from "@repo/database/media-job-notifications";
import { getMediaJobEventsBinding } from "@repo/jobs/realtime/context";

import { subscribeMediaJobEvents } from "./job-events-handler";

export { mediaJobEventsRoute } from "./job-events-handler";

export function serveMediaJobEvents(request: Request): Promise<Response> {
	if (process.env.MEDIA_JOB_EVENTS_ENABLED !== "true")
		return Promise.resolve(
			Response.json(
				{ code: "NOTIFICATIONS_UNAVAILABLE" },
				{ status: 503, headers: { "cache-control": "no-store" } },
			),
		);
	return subscribeMediaJobEvents(request, {
		binding: getMediaJobEventsBinding(),
		getSession: (headers) => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
		ownsJob: ownsMediaJobSubscription,
	});
}
