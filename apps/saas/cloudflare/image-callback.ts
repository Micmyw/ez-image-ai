import { createFlowTiming } from "@repo/api/modules/media/lib/flow-timing";
import { runWithDatabaseClientConstructionObserver } from "@repo/database/client";

/** Exact POST routes only. Canonical-origin validation and the request DB scope still run first. */
export function createImageCallbackIngress(request: Request) {
	if (request.method !== "POST") return null;
	const path = new URL(request.url).pathname;
	if (path !== "/api/webhooks/ai/kie" && path !== "/api/webhooks/moderation/seeapi-image")
		return null;
	const requestId = crypto.randomUUID();
	const timing = createFlowTiming({ requestId });
	timing.mark("callback.ingress.received", 0);
	return {
		timing,
		async handle(forwarded: Request): Promise<Response> {
			return runWithDatabaseClientConstructionObserver(
				(elapsedMs) => timing.mark("callback.db.client-construct", elapsedMs),
				async () => {
					// Reuse the Node/Hono handlers and their bounded raw-body readers, signature
					// checks and persist-before-wake protocol; no fallback after uncertain work.
					const handler = await timing.measure("callback.ingress.load", async () =>
						path === "/api/webhooks/ai/kie"
							? (
									await import("@repo/api/modules/media/webhooks/kie-callback")
								).createKieCallbackHandler()
							: (
									await import("@repo/api/modules/media/webhooks/image-moderation-callback")
								).createImageModerationCallbackHandler(),
					);
					const response = await handler(forwarded, timing);
					response.headers.set("cache-control", "no-store");
					response.headers.set("x-request-id", requestId);
					return response;
				},
			);
		},
	};
}
