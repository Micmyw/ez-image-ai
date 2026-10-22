import { subscribeMediaJobEvents } from "../../../packages/api/modules/media/job-events-handler";
import { runScopedWorkerRequest } from "../../saas/cloudflare/request-scope";
import { forwardToWebsite } from "../../web-host/src/forward";
import { handleJobEventsRequest, isJobEventsRequest } from "../src/job-events";

export { MediaJobEvents } from "../src/media-job-events";

interface Environment {
	MEDIA_JOB_EVENTS: DurableObjectNamespace;
	WORKFLOWS_DISPATCH_SECRET: string;
}

// The session/DB fixture is local-only; production uses Better Auth and an owner-scoped query.
export default {
	fetch(request: Request, environment: Environment, context: ExecutionContext) {
		if (isJobEventsRequest(request)) return handleJobEventsRequest(request, environment);
		return forwardToWebsite(request, "https://app.example", (forwarded) =>
			runScopedWorkerRequest(
				forwarded,
				environment,
				context,
				{
					run: (callback) => callback(),
					dispose: async () => {},
				},
				(scoped) =>
					subscribeMediaJobEvents(scoped, {
						binding: environment.MEDIA_JOB_EVENTS,
						getSession: async (headers) =>
							headers.get("cookie") === "session=owner"
								? { user: { id: "owner" }, session: { expiresAt: new Date(Date.now() + 300_000) } }
								: null,
						ownsJob: async (ownerId, jobId) => ownerId === "owner" && jobId.startsWith("owner-"),
					}),
			),
		);
	},
};
