import { assertWorkflowsConfiguration } from "@repo/config/server";

import { MAX_DISPATCH_BYTES, signRequest } from "./auth";
import {
	OutboxDeliveryPendingError,
	parseImagePhaseOwner,
	type ImagePhaseOwner,
	type TaskTrace,
} from "./contracts";
import { getJobDispatchBinding } from "./dispatch-binding";

type DispatchConfiguration = { url: string; secret: string; fetch?: typeof fetch };

async function send(config: DispatchConfiguration, url: URL, body: string, timeoutMs: number) {
	const init: RequestInit = {
		method: "POST",
		body,
		headers: await signRequest(config.secret, "POST", url.pathname, body),
		signal: AbortSignal.timeout(timeoutMs),
		redirect: "manual",
	};
	if (config.fetch) return config.fetch(url, init);
	const binding = getJobDispatchBinding();
	return binding ? binding.fetch(new Request(url, init)) : fetch(url, init);
}

export interface DispatchOptions {
	idempotencyKey?: string;
	requireCompletion?: boolean;
	timeoutMs?: number;
	trace?: TaskTrace;
}

export interface WakeOptions extends Omit<DispatchOptions, "requireCompletion"> {
	/** The callback transaction's current phase owner. Never supplied by the browser. */
	phaseOwner?: ImagePhaseOwner;
}

export function createJobDispatcher(config: DispatchConfiguration) {
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
		const body = JSON.stringify({
			taskId,
			payload,
			idempotencyKey,
			...(options.trace ? { trace: options.trace } : {}),
		});
		if (new TextEncoder().encode(body).byteLength > MAX_DISPATCH_BYTES)
			throw new Error("BODY_TOO_LARGE");
		const response = await send(config, url, body, options.timeoutMs ?? 15_000);
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

/** Only leased read/reconcile operations can enter without a new Workflow. */
export function createJobWaker(config: DispatchConfiguration) {
	const fallback = createJobDispatcher(config);
	return async (
		taskId: string,
		payload: Record<string, unknown>,
		options: WakeOptions = {},
	): Promise<void> => {
		if (!["media-verify-upload", "media-poll-generation"].includes(taskId))
			throw new Error("INVALID_WAKE_TASK");
		const phaseOwner =
			options.phaseOwner === undefined ? undefined : parseImagePhaseOwner(options.phaseOwner);
		const url = new URL(config.url);
		url.pathname = phaseOwner ? "/internal/phase-wake" : "/internal/wake";
		const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
		if (!idempotencyKey || idempotencyKey.length > 512) throw new Error("INVALID_IDEMPOTENCY_KEY");
		const body = JSON.stringify({
			taskId,
			payload,
			idempotencyKey,
			...(phaseOwner ? { phaseOwner } : {}),
			...(options.trace ? { trace: options.trace } : {}),
		});
		if (new TextEncoder().encode(body).byteLength > MAX_DISPATCH_BYTES)
			throw new Error("BODY_TOO_LARGE");
		const response = await send(config, url, body, options.timeoutMs ?? 3_000);
		if (response.status === 404 && !phaseOwner) {
			// Receiver-first upgrade: a confirmed missing endpoint alone selects
			// the legacy read-only Workflow. Uncertain responses are never replayed.
			await fallback(taskId, payload, { ...options, idempotencyKey });
			return;
		}
		if (response.status !== 202) throw new Error("WORKFLOWS_WAKE_REJECTED");
		const result = (await response.json()) as {
			accepted?: unknown;
			wake?: unknown;
			id?: unknown;
			phaseOwner?: unknown;
		};
		if (phaseOwner) {
			// A signal never starts a second execution chain, including on an old
			// receiver or a lost response. The committed due time and owner's durable
			// timeout remain recovery; acknowledgement must name the exact epoch.
			const confirmed = parseImagePhaseOwner(result.phaseOwner);
			if (
				result.accepted !== true ||
				result.wake !== true ||
				result.id !== phaseOwner.workflowId ||
				confirmed.workflowId !== phaseOwner.workflowId ||
				confirmed.phaseKey !== phaseOwner.phaseKey ||
				confirmed.epoch !== phaseOwner.epoch
			)
				throw new Error("WORKFLOWS_PHASE_WAKE_UNCONFIRMED");
			return;
		}
		if (
			result.accepted !== true ||
			result.wake !== true ||
			typeof result.id !== "string" ||
			!/^job-[a-f0-9]{64}$/.test(result.id)
		)
			throw new Error("WORKFLOWS_WAKE_UNCONFIRMED");
	};
}

export async function wakeJob(
	taskId: string,
	payload: Record<string, unknown>,
	options?: WakeOptions,
): Promise<void> {
	await createJobWaker({
		url: process.env.WORKFLOWS_DISPATCH_URL ?? "",
		secret: process.env.WORKFLOWS_DISPATCH_SECRET ?? "",
	})(taskId, payload, options);
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
