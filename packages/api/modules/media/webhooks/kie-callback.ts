import { wakeKieGenerationAttempt } from "@repo/database";
import { db } from "@repo/database/client";
import { dispatchJob } from "@repo/jobs/orchestration/client";
import { verifyKieCompletionCallback } from "@repo/jobs/orchestration/kie-callback-auth";
import { z } from "zod";

const bodySchema = z.object({ data: z.object({ taskId: z.string().min(1).max(128) }) });
const MAX_CALLBACK_BYTES = 64 * 1024;

interface Dependencies {
	secret(): string | undefined;
	wake(input: {
		attemptId: string;
		providerTaskId: string;
	}): ReturnType<typeof wakeKieGenerationAttempt>;
	dispatch: typeof dispatchJob;
}

export function createKieCallbackHandler(
	dependencies: Dependencies = {
		secret: () => process.env.WORKFLOWS_DISPATCH_SECRET,
		wake: (input) => wakeKieGenerationAttempt(input, db),
		dispatch: dispatchJob,
	},
) {
	return async (request: Request): Promise<Response> => {
		const attemptId = verifyKieCompletionCallback(new URL(request.url), dependencies.secret());
		if (!attemptId) return Response.json({ code: "WEBHOOK_VERIFICATION_FAILED" }, { status: 401 });
		let providerTaskId: string;
		try {
			providerTaskId = bodySchema.parse(await readCallbackBody(request)).data.taskId;
		} catch {
			return Response.json({ code: "WEBHOOK_INVALID" }, { status: 400 });
		}
		const outcome = await dependencies.wake({ attemptId, providerTaskId });
		if (outcome === "invalid") return Response.json({ code: "WEBHOOK_INVALID" }, { status: 400 });
		// The provider may finish before submission acceptance is committed locally.
		if (outcome === "pending") return Response.json({ code: "CALLBACK_RETRY" }, { status: 503 });
		if (outcome === "ready") {
			try {
				await dependencies.dispatch(
					"media-poll-generation",
					{ attemptId },
					{
						idempotencyKey: `generation-callback:${attemptId}`,
						timeoutMs: 3_000,
					},
				);
			} catch {
				// Keep normal polling and scheduled recovery; let the provider retry the same wake-up.
				return Response.json({ code: "CALLBACK_RETRY" }, { status: 503 });
			}
		}
		return Response.json({ accepted: true }, { status: 202 });
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
