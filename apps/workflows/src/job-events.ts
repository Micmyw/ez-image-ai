import { readBoundedBody, verifyRequest } from "@repo/jobs/orchestration/auth";
import { mediaJobEventsStub, type MediaJobEventsNamespace } from "@repo/jobs/realtime/context";
import { MEDIA_JOB_EVENTS_PATH, readMediaJobNotification } from "@repo/jobs/realtime/contracts";

export function isJobEventsRequest(request: Request): boolean {
	return new URL(request.url).pathname === MEDIA_JOB_EVENTS_PATH;
}

export async function handleJobEventsRequest(
	request: Request,
	environment: { MEDIA_JOB_EVENTS?: MediaJobEventsNamespace; WORKFLOWS_DISPATCH_SECRET?: string },
): Promise<Response> {
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
	let body: string;
	try {
		body = await readBoundedBody(request, 2_048);
	} catch {
		return new Response("Invalid body", { status: 400 });
	}
	if (
		!(await verifyRequest(
			environment.WORKFLOWS_DISPATCH_SECRET ?? "",
			request.method,
			MEDIA_JOB_EVENTS_PATH,
			body,
			request.headers,
		))
	)
		return new Response("Unauthorized", { status: 401 });
	let notification;
	try {
		notification = readMediaJobNotification(JSON.parse(body));
	} catch {
		return new Response("Invalid notification", { status: 400 });
	}
	if (!environment.MEDIA_JOB_EVENTS) return new Response("Unavailable", { status: 503 });
	return mediaJobEventsStub(environment.MEDIA_JOB_EVENTS, notification.jobId).fetch(
		new Request("https://media-job-events.internal/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(notification),
		}),
	);
}
