import { verifySeeapiVideoWebhook } from "@repo/ai/media/moderation/seeapi-video-webhook";
import { db } from "@repo/database/client";
import {
	wakeImageModerationWithOwner,
	type wakeImageModeration,
} from "@repo/database/media-image-callback";
import { wakeJob } from "@repo/jobs/orchestration/client";
import {
	imageModerationCallbackConfig,
	verifyImageModerationCallbackUrl,
} from "@repo/jobs/orchestration/image-moderation-callback-auth";

import { createFlowTiming, type FlowTiming } from "../lib/flow-timing";

const MAX_BYTES = 64 * 1024;
interface Dependencies {
	environment(): Record<string, string | undefined>;
	wake(
		input: Parameters<typeof wakeImageModeration>[0],
		timing: FlowTiming,
	): Promise<
		| Awaited<ReturnType<typeof wakeImageModerationWithOwner>>
		| Awaited<ReturnType<typeof wakeImageModeration>>
	>;
	dispatch: typeof wakeJob;
}
export function createImageModerationCallbackHandler(
	dependencies: Dependencies = {
		environment: () => process.env,
		wake: (input, timing) =>
			wakeImageModerationWithOwner(input, db, {
				onTiming: (stage, elapsedMs, outcome) =>
					timing.mark(`image-callback.db.${stage}`, elapsedMs, undefined, outcome),
			}),
		dispatch: wakeJob,
	},
) {
	return async (
		request: Request,
		timing = createFlowTiming({ requestId: crypto.randomUUID() }),
	): Promise<Response> =>
		timing.measure("image-callback.total", async () => {
			const environment = dependencies.environment();
			const authStarted = performance.now();
			const identity = verifyImageModerationCallbackUrl(request.url, environment);
			if (identity) timing.bind({ assetId: identity.assetId });
			timing.mark("image-callback.auth", performance.now() - authStarted);
			if (!identity) return Response.json({ code: "WEBHOOK_VERIFICATION_FAILED" }, { status: 401 });
			let bytes: Uint8Array;
			try {
				bytes = await timing.measure("image-callback.body", () => readBody(request));
			} catch {
				return Response.json({ code: "WEBHOOK_INVALID" }, { status: 400 });
			}
			if (
				!(await timing.measure("image-callback.signature", () =>
					verifySeeapiVideoWebhook({
						rawBody: bytes,
						timestampHeader: request.headers.get("X-SEEAPI-Timestamp"),
						signatureHeader: request.headers.get("X-SEEAPI-Signature"),
						signingKeyHeader: request.headers.get("X-SEEAPI-Signing-Key"),
						keys: imageModerationCallbackConfig(environment).keys,
					}),
				))
			)
				return Response.json({ code: "WEBHOOK_VERIFICATION_FAILED" }, { status: 401 });
			// The body is intentionally never interpreted as approval, task identity or a URL.
			try {
				const outcome = await timing.measure("image-callback.persist", () =>
					dependencies.wake(identity, timing),
				);
				const status = typeof outcome === "string" ? outcome : outcome.status;
				const phaseOwner = typeof outcome === "string" ? undefined : outcome.phaseOwner;
				if (status === "invalid")
					return Response.json({ code: "WEBHOOK_INVALID" }, { status: 400 });
				if (status === "ready")
					await timing.measure("image-callback.wake", () =>
						dependencies.dispatch(
							"media-verify-upload",
							{ assetId: identity.assetId },
							{
								idempotencyKey: `image-review-callback:${identity.assetId}:${identity.generation}:${identity.submissionToken}`,
								timeoutMs: 3_000,
								...(phaseOwner ? { phaseOwner } : {}),
							},
						),
					);
				return Response.json({ accepted: true }, { status: 202 });
			} catch {
				// The durable due time, ordinary polling and recovery all survive a lost wake.
				return Response.json({ code: "CALLBACK_RETRY" }, { status: 503 });
			}
		});
}
async function readBody(request: Request): Promise<Uint8Array> {
	if (Number(request.headers.get("content-length")) > MAX_BYTES || !request.body)
		throw new Error("INVALID_BODY");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_BYTES) {
				await reader.cancel();
				throw new Error("INVALID_BODY");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
