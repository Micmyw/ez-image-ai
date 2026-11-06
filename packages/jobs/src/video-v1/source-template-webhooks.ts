import { verifySeeapiVideoWebhook } from "@repo/ai/media/moderation/seeapi-video-webhook";
import { readVideoSeeapiCallbackConfig } from "@repo/config/video-seeapi-callback";
import { resolveVideoV1CallbackBaseUrl } from "@repo/config/video-v1";
import {
	persistSourceTemplateCallback,
	markSourceTemplateCallbackNotified,
} from "@repo/database/video-source-template-events";

import type { VideoWorkflowBinding } from "./contracts";
import { sourceCallbackTokenHash } from "./source-template-callback-url";

export interface SourceTemplateWebhookDependencies {
	binding?: VideoWorkflowBinding;
	environment?: Record<string, string | undefined>;
	persist?: typeof persistSourceTemplateCallback;
	markNotified?: typeof markSourceTemplateCallbackNotified;
	now?: () => Date;
}
class CallbackError extends Error {
	constructor(readonly status: number) {
		super("SOURCE_CALLBACK_REJECTED");
	}
}
async function bodyBytes(request: Request) {
	if (Number(request.headers.get("content-length")) > 256 * 1024 || !request.body)
		throw new CallbackError(413);
	const reader = request.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > 256 * 1024) {
				await reader.cancel();
				throw new CallbackError(413);
			}
			parts.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return bytes;
}
/** Authenticate -> durable inbox -> exact Workflow. Never queries providers or dispatches Outbox. */
export function createSourceTemplateWebhookHandler(
	options: SourceTemplateWebhookDependencies = {},
) {
	return async (request: Request): Promise<Response> => {
		try {
			const env = options.environment ?? process.env;
			const url = new URL(request.url);
			const generation = /^\/api\/webhooks\/video-source\/(kie|seeapi)\/([a-f0-9]{64})$/.exec(
				url.pathname,
			);
			const input =
				/^\/api\/webhooks\/video-source-input\/([A-Za-z0-9_-]{1,160})\/([A-Za-z0-9_-]{1,80})\/([a-f0-9]{64})$/.exec(
					url.pathname,
				);
			if (
				request.method !== "POST" ||
				url.origin !== resolveVideoV1CallbackBaseUrl(env) ||
				url.search ||
				url.hash ||
				(!generation && !input)
			)
				throw new CallbackError(401);
			const provider = input ? "seeapi" : (generation![1] as "kie" | "seeapi");
			const token = input ? input[3]! : generation![2]!;
			const bytes = await bodyBytes(request);
			const now = options.now?.() ?? new Date();
			if (provider === "seeapi") {
				const config = readVideoSeeapiCallbackConfig(env);
				if (
					!config.ready ||
					!(await verifySeeapiVideoWebhook({
						rawBody: bytes,
						timestampHeader: request.headers.get("X-SEEAPI-Timestamp"),
						signatureHeader: request.headers.get("X-SEEAPI-Signature"),
						signingKeyHeader: request.headers.get("X-SEEAPI-Signing-Key"),
						keys: config.keys,
						nowSeconds: now.getTime() / 1000,
					}))
				)
					throw new CallbackError(401);
			}
			let rawBody: string;
			try {
				rawBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
				const value: unknown = JSON.parse(rawBody.replace(/^\uFEFF/, ""));
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
			} catch {
				throw new CallbackError(400);
			}
			const event = await (options.persist ?? persistSourceTemplateCallback)({
				phase: input ? "input" : "generation",
				provider,
				tokenHash: await sourceCallbackTokenHash(token),
				...(input ? { jobId: input[1]!, role: input[2]! } : {}),
				rawBody,
				eventHash: await sourceCallbackTokenHash(rawBody),
				receivedAt: now,
			});
			if (!event.notified) {
				if (!options.binding || event.workflowInstanceId !== `video-v1-${event.jobId}`)
					throw new CallbackError(503);
				await (
					await options.binding.get(event.workflowInstanceId)
				).sendEvent({
					type: event.phase === "input" ? "moderation-result" : "provider-result",
					payload: { jobId: event.jobId, eventId: event.eventId },
				});
				await (options.markNotified ?? markSourceTemplateCallbackNotified)(event.eventId);
			}
			return Response.json({ accepted: true }, { status: 202 });
		} catch (error) {
			const status =
				error instanceof CallbackError
					? error.status
					: error instanceof Error &&
						  [
								"SOURCE_CALLBACK_IDENTITY_INVALID",
								"VIDEO_INPUT_IDENTITY_CHANGED",
								"VIDEO_JOB_NOT_FOUND",
						  ].includes(error.message)
						? 401
						: 503;
			return Response.json(
				{ code: status === 503 ? "SOURCE_CALLBACK_RETRY" : "SOURCE_CALLBACK_REJECTED" },
				{ status },
			);
		}
	};
}
