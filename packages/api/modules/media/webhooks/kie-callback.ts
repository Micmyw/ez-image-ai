import { verifyKieWebhook } from "@repo/ai/media/providers/kie-webhook";
import {
	kieImageCallbackTaskId,
	parseKieImageCallbackCompletion,
	type KieImageCallbackCompletion,
} from "@repo/config/kie-image-callback";
import { db } from "@repo/database/client";
import {
	wakeKieGenerationAttemptWithOwner,
	type wakeKieGenerationAttempt,
} from "@repo/database/media-kie-callback";
import { wakeJob } from "@repo/jobs/orchestration/client";
import {
	verifyKieCompletionCallback,
	readKieImageResultContext,
} from "@repo/jobs/orchestration/kie-callback-auth";
import { providerCdnAllowlist } from "@repo/jobs/provider-output-policy";
import { importImageResult } from "@repo/jobs/realtime/import-image-result";
import { submitImageResult, pollImageResult } from "@repo/jobs/realtime/review-image-result";
import { getRequestDefer } from "@repo/utils/request-lifecycle";

import { createFlowTiming, type FlowTiming } from "../lib/flow-timing";

const MAX_CALLBACK_BYTES = 64 * 1024;

interface Dependencies {
	secret(): string | undefined;
	webhookSecret?(): string | undefined;
	allowedHosts?(): readonly string[];
	now?(): Date;
	wake(
		input: {
			attemptId: string;
			providerTaskId: string;
			completion?: KieImageCallbackCompletion;
		},
		timing: FlowTiming,
	): Promise<
		| Awaited<ReturnType<typeof wakeKieGenerationAttemptWithOwner>>
		| Awaited<ReturnType<typeof wakeKieGenerationAttempt>>
	>;
	dispatch: typeof wakeJob;
	startOutputReview?: typeof submitImageResult;
	pollOutputReview?: typeof pollImageResult;
	importOutput?: typeof importImageResult;
}

export function createKieCallbackHandler(
	dependencies: Dependencies = {
		secret: () => process.env.WORKFLOWS_DISPATCH_SECRET,
		webhookSecret: () => process.env.KIE_WEBHOOK_SECRET,
		allowedHosts: () => providerCdnAllowlist(process.env),
		wake: (input, timing) =>
			wakeKieGenerationAttemptWithOwner(input, db, {
				onTiming: (stage, elapsedMs, outcome) =>
					timing.mark(`callback.db.${stage}`, elapsedMs, undefined, outcome),
			}),
		dispatch: wakeJob,
		startOutputReview: submitImageResult,
		pollOutputReview: pollImageResult,
		importOutput: importImageResult,
	},
) {
	return async (
		request: Request,
		timing = createFlowTiming({ requestId: crypto.randomUUID() }),
	): Promise<Response> => {
		return timing.measure("callback.total", async () => {
			const authStarted = performance.now();
			const attemptId = verifyKieCompletionCallback(new URL(request.url), dependencies.secret());
			if (attemptId) timing.bind({ attemptId });
			timing.mark("callback.auth", performance.now() - authStarted);
			if (!attemptId)
				return Response.json({ code: "WEBHOOK_VERIFICATION_FAILED" }, { status: 401 });
			let providerTaskId: string;
			let body: unknown;
			try {
				body = await timing.measure("callback.body", () => readCallbackBody(request));
				const taskId = kieImageCallbackTaskId(body);
				if (!taskId) throw new Error("INVALID_TASK_ID");
				providerTaskId = taskId;
			} catch {
				return Response.json({ code: "WEBHOOK_INVALID" }, { status: 400 });
			}
			const receivedAt = dependencies.now?.() ?? new Date();
			const webhookSecret = dependencies.webhookSecret?.();
			let completion: KieImageCallbackCompletion | undefined;
			if (webhookSecret) {
				const verified = await timing.measure("callback.signature", () =>
					verifyKieWebhook({
						taskId: providerTaskId,
						timestamp: request.headers.get("x-webhook-timestamp"),
						signature: request.headers.get("x-webhook-signature"),
						secret: webhookSecret,
						nowSeconds: Math.floor(receivedAt.getTime() / 1000),
					}),
				);
				if (!verified)
					return Response.json({ code: "WEBHOOK_VERIFICATION_FAILED" }, { status: 401 });
				completion = parseKieImageCallbackCompletion(body, {
					allowedHosts: dependencies.allowedHosts?.() ?? providerCdnAllowlist(process.env),
					receivedAt,
				});
			}
			// An unconfigured receiver keeps query-only recovery. A configured receiver
			// never downgrades a missing/invalid official signature to a URL-token-only result.
			const persistAndWake = async () => {
				const outcome = await timing.measure("callback.database", () =>
					dependencies.wake(
						{ attemptId, providerTaskId, ...(completion ? { completion } : {}) },
						timing,
					),
				);
				const status = typeof outcome === "string" ? outcome : outcome.status;
				const phaseOwner = typeof outcome === "string" ? undefined : outcome.phaseOwner;
				if (status === "invalid")
					return Response.json({ code: "WEBHOOK_INVALID" }, { status: 400 });
				// Early or duplicate notices are durable; the original acceptance/query owns recovery.
				if (status === "ready") {
					try {
						await timing.measure("callback.wake", () =>
							dependencies.dispatch(
								"media-poll-generation",
								{ attemptId },
								{
									idempotencyKey: `generation-callback:${attemptId}`,
									timeoutMs: 3_000,
									...(phaseOwner ? { phaseOwner } : {}),
								},
							),
						);
					} catch {
						// Keep normal polling and scheduled recovery; let the provider retry the same wake-up.
						return Response.json({ code: "CALLBACK_RETRY" }, { status: 503 });
					}
				}
				return Response.json({ accepted: true }, { status: 202 });
			};
			const context =
				completion && readKieImageResultContext(new URL(request.url), dependencies.secret());
			if (
				completion &&
				context &&
				dependencies.startOutputReview &&
				dependencies.pollOutputReview
			) {
				try {
					// Start SeeAPI before any association, dedupe record, provider GET or DB write.
					const receipt = await timing.measure("callback.output-review-submit", () =>
						dependencies.startOutputReview!(context, completion!),
					);
					// Both branches have a managed lifetime. Neither database work nor the wake
					// response is a prerequisite for querying/publishing the approved original.
					const work = Promise.allSettled([
						persistAndWake(),
						dependencies
							.pollOutputReview(receipt)
							.then((reviewed) => dependencies.importOutput?.(reviewed, db)),
					]);
					const defer = getRequestDefer();
					if (defer) defer(work);
					else await work;
					return Response.json({ accepted: true }, { status: 202 });
				} catch {
					// Retry this exact signed callback/key. Unknown acceptance never falls
					// through into a second submission with a different request identity.
					return Response.json({ code: "CALLBACK_RETRY" }, { status: 503 });
				}
			}
			return persistAndWake();
		});
	};
}

async function readCallbackBody(request: Request): Promise<unknown> {
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
	const buffer = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(buffer));
}
