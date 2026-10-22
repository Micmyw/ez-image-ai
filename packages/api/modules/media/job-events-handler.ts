import { mediaJobEventsStub, type MediaJobEventsNamespace } from "@repo/jobs/realtime/context";
import {
	MEDIA_JOB_EVENTS_PROTOCOL,
	MEDIA_JOB_SUBSCRIPTION_TTL_MS,
} from "@repo/jobs/realtime/contracts";

export function mediaJobEventsRoute(request: Request): string | null {
	return (
		/^\/api\/media\/jobs\/([A-Za-z0-9_-]{1,128})\/events$/.exec(
			new URL(request.url).pathname,
		)?.[1] ?? null
	);
}

export interface MediaJobSubscriptionDependencies {
	binding?: MediaJobEventsNamespace;
	getSession(headers: Headers): Promise<{
		user: { id: string; isAnonymous?: boolean | null };
		session?: { expiresAt: Date | string };
	} | null>;
	ownsJob(userId: string, jobId: string): Promise<boolean>;
	now?(): number;
}

export async function subscribeMediaJobEvents(
	request: Request,
	dependencies: MediaJobSubscriptionDependencies,
): Promise<Response> {
	const jobId = mediaJobEventsRoute(request);
	const fail = (code: string, status: number) =>
		Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
	if (!jobId) return fail("NOT_FOUND", 404);
	if (request.method !== "GET") return fail("METHOD_NOT_ALLOWED", 405);
	if (request.headers.get("origin") !== new URL(request.url).origin)
		return fail("ORIGIN_REQUIRED", 403);
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
		return fail("WEBSOCKET_REQUIRED", 426);
	if (!dependencies.binding) return fail("NOTIFICATIONS_UNAVAILABLE", 503);
	const session = await dependencies.getSession(request.headers);
	if (!session || session.user.isAnonymous) return fail("UNAUTHORIZED", 401);
	const now = dependencies.now ? dependencies.now() : Date.now();
	const sessionExpiry = session.session
		? new Date(session.session.expiresAt).getTime()
		: now + MEDIA_JOB_SUBSCRIPTION_TTL_MS;
	if (!Number.isFinite(sessionExpiry) || sessionExpiry <= now) return fail("UNAUTHORIZED", 401);
	if (!(await dependencies.ownsJob(session.user.id, jobId))) return fail("NOT_FOUND", 404);
	const target = new URL("https://media-job-events.internal/subscribe");
	target.searchParams.set("jobId", jobId);
	target.searchParams.set(
		"expiresAt",
		String(Math.min(sessionExpiry, now + MEDIA_JOB_SUBSCRIPTION_TTL_MS)),
	);
	if (new URL(request.url).searchParams.get("protocol") === String(MEDIA_JOB_EVENTS_PROTOCOL))
		target.searchParams.set("protocol", String(MEDIA_JOB_EVENTS_PROTOCOL));
	// Only server-derived identity and a fixed protocol capability enter the hub.
	// Cookies, client identity, cursors and expiry overrides never do.
	return mediaJobEventsStub(dependencies.binding, jobId).fetch(
		new Request(target, { headers: { upgrade: "websocket" } }),
	);
}
