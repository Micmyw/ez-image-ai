import { verifySeeapiVideoWebhook } from "@repo/ai/media/moderation/seeapi-video-webhook";
import { readVideoSeeapiCallbackConfig } from "@repo/config/video-seeapi-callback";
import type { VideoModerationEventReference } from "@repo/database/video-v1-moderation-events";
import {
	listPendingSeeapiVideoModerationEvents,
	markSeeapiVideoModerationWebhookNotified,
	persistSeeapiVideoModerationWebhook,
} from "@repo/database/video-v1-seeapi-events";

import type { AcceptedWebhookResult, VideoWorkflowBinding } from "./contracts";
import { verifySeeapiVideoCallbackUrl } from "./seeapi-callback-url";

const MAX_BODY_BYTES = 256 * 1024;
class SeeapiWebhookError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}
export interface SeeapiVideoModerationWebhookDependencies {
	binding?: VideoWorkflowBinding;
	environment?: Record<string, string | undefined>;
	persist?: typeof persistSeeapiVideoModerationWebhook;
	markNotified?: typeof markSeeapiVideoModerationWebhookNotified;
	now?: () => Date;
}
async function readRawBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
	if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES)
		throw new SeeapiWebhookError(413, "VIDEO_SEEAPI_CALLBACK_TOO_LARGE");
	const reader = request.body?.getReader();
	if (!reader) throw new SeeapiWebhookError(400, "VIDEO_SEEAPI_CALLBACK_INVALID_BODY");
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_BODY_BYTES) {
				await reader.cancel();
				throw new SeeapiWebhookError(413, "VIDEO_SEEAPI_CALLBACK_TOO_LARGE");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
async function notify(
	event: VideoModerationEventReference,
	binding: VideoWorkflowBinding | undefined,
	mark: typeof markSeeapiVideoModerationWebhookNotified,
): Promise<boolean> {
	if (event.notified) return true;
	if (!binding || !event.jobId || event.workflowInstanceId !== `video-v1-${event.jobId}`)
		return false;
	try {
		const instance = await binding.get(event.workflowInstanceId);
		await instance.sendEvent({
			type: "moderation-result",
			payload: { jobId: event.jobId, eventId: event.eventId },
		});
		await mark(event.eventId);
		return true;
	} catch {
		return false;
	}
}

/** Raw signed bytes are evidence only. The URL binds the attempt; a fenced GET confirms status. */
export async function acceptSeeapiVideoModerationWebhook(
	request: Request,
	options: SeeapiVideoModerationWebhookDependencies = {},
): Promise<AcceptedWebhookResult> {
	const environment = options.environment ?? process.env;
	const config = readVideoSeeapiCallbackConfig(environment);
	const identity = await verifySeeapiVideoCallbackUrl(request.url, environment);
	if (!config.ready || !identity)
		throw new SeeapiWebhookError(401, "VIDEO_SEEAPI_CALLBACK_UNAUTHORIZED");
	const bytes = await readRawBody(request);
	const receivedAt = options.now?.() ?? new Date();
	if (
		!(await verifySeeapiVideoWebhook({
			rawBody: bytes,
			timestampHeader: request.headers.get("X-SEEAPI-Timestamp"),
			signatureHeader: request.headers.get("X-SEEAPI-Signature"),
			signingKeyHeader: request.headers.get("X-SEEAPI-Signing-Key"),
			keys: config.keys,
			nowSeconds: Math.floor(receivedAt.getTime() / 1000),
		}))
	)
		throw new SeeapiWebhookError(401, "VIDEO_SEEAPI_CALLBACK_UNAUTHORIZED");
	let rawBody: string;
	try {
		const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
		const parsed: unknown = JSON.parse(decoded);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("INVALID_BODY");
		// TextDecoder strips a UTF-8 BOM. Preserve it in stored evidence and its original hash.
		rawBody =
			(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "\uFEFF" : "") + decoded;
	} catch {
		throw new SeeapiWebhookError(400, "VIDEO_SEEAPI_CALLBACK_INVALID_BODY");
	}
	const eventHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	const metadata = (name: string) => request.headers.get(name)?.slice(0, 256) ?? null;
	let event: VideoModerationEventReference;
	try {
		event = await (options.persist ?? persistSeeapiVideoModerationWebhook)({
			...identity,
			rawBody,
			eventHash,
			receivedAt,
			// Delivery/Event are unsigned metadata and never control dedupe, lookup or approval.
			deliveryMetadata: {
				delivery: metadata("X-SEEAPI-Delivery"),
				event: metadata("X-SEEAPI-Event"),
			},
		});
	} catch (error) {
		if (error instanceof Error && error.message === "VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID")
			throw new SeeapiWebhookError(401, "VIDEO_SEEAPI_CALLBACK_UNAUTHORIZED");
		throw error;
	}
	const notified = await notify(
		event,
		options.binding,
		options.markNotified ?? markSeeapiVideoModerationWebhookNotified,
	);
	// A bound event must reach the Workflow. Let the provider retry durable inbox delivery;
	// early callbacks have no task ID yet and are delivered after recordTask succeeds.
	if (event.jobId && !notified) throw new SeeapiWebhookError(503, "VIDEO_SEEAPI_CALLBACK_RETRY");
	return {
		accepted: true,
		replayed: event.replayed,
		notified,
		...(event.jobId ? { jobId: event.jobId } : {}),
	};
}
export function createSeeapiVideoModerationWebhookHandler(
	options: SeeapiVideoModerationWebhookDependencies = {},
) {
	return async (request: Request): Promise<Response> => {
		try {
			await acceptSeeapiVideoModerationWebhook(request, options);
			return Response.json({ accepted: true }, { status: 202 });
		} catch (error) {
			const known = error instanceof SeeapiWebhookError;
			return Response.json(
				{ code: known ? error.message : "VIDEO_SEEAPI_CALLBACK_RETRY" },
				{ status: known ? error.status : 503 },
			);
		}
	};
}
/** Targeted early-event delivery after task ID persistence; this performs no provider query. */
export async function notifyPendingSeeapiVideoModerationEvents(options: {
	binding?: VideoWorkflowBinding;
	jobId: string;
	limit?: number;
	events?: typeof listPendingSeeapiVideoModerationEvents;
	markNotified?: typeof markSeeapiVideoModerationWebhookNotified;
}) {
	const result = { notified: 0, failed: 0 };
	if (!options.binding) return result;
	for (const event of await (options.events ?? listPendingSeeapiVideoModerationEvents)(
		options.limit ?? 50,
		options.jobId,
	)) {
		if (
			await notify(
				event,
				options.binding,
				options.markNotified ?? markSeeapiVideoModerationWebhookNotified,
			)
		)
			result.notified++;
		else result.failed++;
	}
	return result;
}
