import type { MediaJobEventsNamespace } from "@repo/jobs/realtime/context";

export const SCANLESS_SUBSCRIPTION_PATH = "/__scanless/job-events";

/** Reserved/abnormal status codes cannot be sent as WebSocket close frames. */
export function scanlessWebSocketClose(code: unknown, reason: unknown) {
	const valid =
		typeof code === "number" &&
		Number.isInteger(code) &&
		([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code) ||
			(code >= 3000 && code <= 4999));
	let safeReason = "";
	let bytes = 0;
	const text = typeof reason === "string" ? reason : "";
	for (const character of text) {
		const size = new TextEncoder().encode(character).byteLength;
		if (bytes + size > 123) break;
		bytes += size;
		safeReason += character;
	}
	return { code: valid ? code : 1011, reason: safeReason };
}

/** Only loaded as the isolated test driver's Worker, never a production entry. */
export const SCANLESS_DRIVER_WORKER = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '${SCANLESS_SUBSCRIPTION_PATH}') {
      const jobId = url.searchParams.get('jobId') ?? '';
      if (request.method !== 'GET' || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId))
        return new Response('Invalid test bridge subscription', { status: 400 });
      const target = new URL(request.url);
      target.pathname = '/subscribe';
      target.hostname = 'media-job-events.internal';
      const stub = env.MEDIA_JOB_EVENTS.get(env.MEDIA_JOB_EVENTS.idFromName('media-job:' + jobId));
      return stub.fetch(new Request(target, request));
    }
    // Regression probe: a Node-handled outbound request must progress while
    // subscriptions are pending. No business task invokes this test-only route.
    if (url.pathname === '/__scanless/fixture-loopback')
      return fetch('https://scanless-fixture.invalid/wait');
    if (url.pathname === '/internal/execute')
      return env.EXECUTOR.get(env.EXECUTOR.idFromName('jobs-maintenance')).fetch(request);
    return env.ENTRY.fetch(request);
  }
};`;

/** Node uses only asynchronous dispatch; real DO IDs and stubs stay in workerd. */
export function createScanlessSubscriptionNamespace(
	dispatch: (
		url: string,
		init: { method: string; headers: Record<string, string> },
	) => Promise<Response>,
): MediaJobEventsNamespace {
	return {
		idFromName: (name) => name,
		get: (name) => ({
			async fetch(request) {
				const target = new URL(request.url);
				const jobId = target.searchParams.get("jobId");
				if (
					request.method !== "GET" ||
					target.hostname !== "media-job-events.internal" ||
					target.pathname !== "/subscribe" ||
					name !== `media-job:${jobId}`
				)
					throw new Error("INVALID_SCANLESS_SUBSCRIPTION_TRANSPORT");
				target.pathname = SCANLESS_SUBSCRIPTION_PATH;
				return dispatch(target.toString(), {
					method: request.method,
					headers: Object.fromEntries(request.headers),
				});
			},
		}),
	};
}
