import { assertWorkflowsConfiguration } from "@repo/config/server";

import { MAX_DISPATCH_BYTES, signRequest } from "./auth";
import { OutboxDeliveryPendingError } from "./contracts";

export interface DispatchOptions {
	idempotencyKey?: string;
	requireCompletion?: boolean;
}

export function createJobDispatcher(config: { url: string; secret: string; fetch?: typeof fetch }) {
	const validated = assertWorkflowsConfiguration({
		WORKFLOWS_DISPATCH_URL: config.url,
		WORKFLOWS_DISPATCH_SECRET: config.secret,
		NODE_ENV: process.env.NODE_ENV,
	});
	const url = new URL(validated.dispatchUrl);
	return async (
		taskId: string,
		payload: Record<string, unknown>,
		options: DispatchOptions = {},
	): Promise<void> => {
		const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
		if (!idempotencyKey || idempotencyKey.length > 512) throw new Error("INVALID_IDEMPOTENCY_KEY");
		const body = JSON.stringify({ taskId, payload, idempotencyKey });
		if (new TextEncoder().encode(body).byteLength > MAX_DISPATCH_BYTES)
			throw new Error("BODY_TOO_LARGE");
		const response = await (config.fetch ?? fetch)(url, {
			method: "POST",
			body,
			headers: await signRequest(config.secret, "POST", url.pathname, body),
			signal: AbortSignal.timeout(15_000),
			redirect: "error",
		});
		// Acceptance means Workflows persisted the instance. A 2xx proxy page or
		// malformed response must not acknowledge an Outbox event.
		if (response.status !== 202) throw new Error("WORKFLOWS_DISPATCH_REJECTED");
		const result = (await response.json()) as {
			accepted?: unknown;
			id?: unknown;
			completed?: unknown;
		};
		if (
			result.accepted !== true ||
			typeof result.id !== "string" ||
			!/^job-[a-f0-9]{64}$/.test(result.id)
		) {
			throw new Error("WORKFLOWS_DISPATCH_UNCONFIRMED");
		}
		if (options.requireCompletion && result.completed !== true)
			throw new OutboxDeliveryPendingError();
	};
}

export async function dispatchJob(
	taskId: string,
	payload: Record<string, unknown>,
	options?: DispatchOptions,
): Promise<void> {
	const dispatcher = createJobDispatcher({
		url: process.env.WORKFLOWS_DISPATCH_URL ?? "",
		secret: process.env.WORKFLOWS_DISPATCH_SECRET ?? "",
	});
	await dispatcher(taskId, payload, options);
}
