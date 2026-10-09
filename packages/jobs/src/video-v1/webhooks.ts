import { verifyKieVideoWebhook } from "@repo/ai/media/providers/kie-video-v1";
import {
	markVideoWebhookNotified,
	persistVideoProviderWebhook,
} from "@repo/database/video-v1-execution";

import type { AcceptedWebhookResult, VideoWorkflowBinding } from "./contracts";
import { hashVideoCallbackToken } from "./submission";

const MAX_CALLBACK_BYTES = 64 * 1024;
export class VideoWebhookError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}
export interface VideoWebhookDependencies {
	binding?: VideoWorkflowBinding;
	environment?: Record<string, string | undefined>;
	persist?: typeof persistVideoProviderWebhook;
	markNotified?: typeof markVideoWebhookNotified;
	now?: () => Date;
}

/** The signed task identity is a wake-up hint; status, URLs and costs in body are discarded. */
export async function acceptVideoProviderWebhook(
	request: Request,
	options: VideoWebhookDependencies = {},
): Promise<AcceptedWebhookResult> {
	const env = options.environment ?? process.env;
	const segments = new URL(request.url).pathname.split("/");
	const token = segments[segments.length - 1] ?? "";
	if (!/^[a-f0-9]{64}$/.test(token)) throw new VideoWebhookError(401, "VIDEO_WEBHOOK_UNAUTHORIZED");
	const timestamp = request.headers.get("x-webhook-timestamp") ?? "";
	const signature = request.headers.get("x-webhook-signature") ?? "";
	const secret = env.KIE_WEBHOOK_SECRET;
	if (!secret || !timestamp || !signature)
		throw new VideoWebhookError(401, "VIDEO_WEBHOOK_UNAUTHORIZED");
	let payload: unknown;
	try {
		payload = await readBoundedBody(request);
	} catch {
		throw new VideoWebhookError(400, "VIDEO_WEBHOOK_INVALID_BODY");
	}
	const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : null;
	const identity =
		data && typeof data === "object" && !Array.isArray(data)
			? (data as Record<string, unknown>)
			: {};
	// The Veo callback uses taskId; the common signature guide also documents task_id.
	// Never select one identity while ignoring a conflicting alias in the same payload.
	if (
		Object.prototype.hasOwnProperty.call(identity, "taskId") &&
		Object.prototype.hasOwnProperty.call(identity, "task_id") &&
		identity.taskId !== identity.task_id
	)
		throw new VideoWebhookError(400, "VIDEO_WEBHOOK_INVALID_TASK");
	const taskId = Object.prototype.hasOwnProperty.call(identity, "taskId")
		? identity.taskId
		: identity.task_id;
	if (typeof taskId !== "string" || !/^[\w-]{1,160}$/.test(taskId))
		throw new VideoWebhookError(400, "VIDEO_WEBHOOK_INVALID_TASK");
	// The common guide also repeats taskId at the envelope root; any such copy must agree.
	const envelope = payload as Record<string, unknown>;
	for (const key of ["taskId", "task_id"])
		if (Object.prototype.hasOwnProperty.call(envelope, key) && envelope[key] !== taskId)
			throw new VideoWebhookError(400, "VIDEO_WEBHOOK_INVALID_TASK");
	const receivedAt = options.now?.() ?? new Date();
	if (
		!(await verifyKieVideoWebhook({
			taskId,
			timestamp,
			signature,
			secret,
			nowSeconds: Math.floor(receivedAt.getTime() / 1000),
		}))
	) {
		throw new VideoWebhookError(401, "VIDEO_WEBHOOK_UNAUTHORIZED");
	}
	let stored;
	try {
		stored = await (options.persist ?? persistVideoProviderWebhook)({
			callbackTokenHash: await hashVideoCallbackToken(token),
			taskId,
			timestamp,
			receivedAt,
		});
	} catch (error) {
		if (
			error instanceof Error &&
			[
				"VIDEO_CALLBACK_ATTEMPT_INVALID",
				"VIDEO_CALLBACK_TASK_INVALID",
				"VIDEO_JOB_NOT_FOUND",
			].includes(error.message)
		)
			throw new VideoWebhookError(401, "VIDEO_WEBHOOK_UNAUTHORIZED");
		throw error; // Persistence failure must make the provider retry; never acknowledge it.
	}
	let notified = stored.notified;
	if (!notified && options.binding) {
		try {
			const instance = await options.binding.get(stored.workflowInstanceId);
			await instance.sendEvent({
				type: "provider-result",
				payload: { eventId: stored.eventId, jobId: stored.jobId },
			});
			await (options.markNotified ?? markVideoWebhookNotified)(
				stored.eventId,
				stored.callbackPersistedAt,
			);
			notified = true;
		} catch {
			/* Durable inbox remains eligible for duplicate delivery and targeted recovery. */
		}
	}
	return { accepted: true, replayed: stored.replayed, notified, jobId: stored.jobId };
}

export function createVideoProviderWebhookHandler(options: VideoWebhookDependencies = {}) {
	return async (request: Request): Promise<Response> => {
		try {
			const result = await acceptVideoProviderWebhook(request, options);
			return Response.json({ accepted: result.accepted }, { status: 202 });
		} catch (error) {
			const status = error instanceof VideoWebhookError ? error.status : 503;
			return Response.json(
				{ code: error instanceof VideoWebhookError ? error.message : "VIDEO_WEBHOOK_RETRY" },
				{ status },
			);
		}
	};
}

async function readBoundedBody(request: Request): Promise<unknown> {
	if (Number(request.headers.get("content-length")) > MAX_CALLBACK_BYTES)
		throw new Error("BODY_TOO_LARGE");
	const reader = request.body?.getReader();
	if (!reader) throw new Error("BODY_REQUIRED");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_CALLBACK_BYTES) {
				await reader.cancel();
				throw new Error("BODY_TOO_LARGE");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(body));
}
