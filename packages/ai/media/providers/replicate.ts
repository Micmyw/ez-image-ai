import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { MediaProviderError } from "../errors";
import type {
	NormalizedResult,
	ProviderCancelInput,
	ProviderCancelResult,
	ProviderRetrieveInput,
	ProviderSubmission,
	ProviderSubmitInput,
	ProviderTaskSnapshot,
	VerifiedProviderEvent,
} from "../types";
import { failureFrom, normalizedResult, normalizeStatus, remoteOutputs } from "./common";
import { fetchJson, rejectedHttpSubmission, type HttpClientOptions } from "./http";
import type { MediaProviderAdapter } from "./provider-adapter";

const responseSchema = z
	.object({
		id: z.string().min(1),
		status: z.string(),
		output: z.union([z.string(), z.array(z.string())]).nullish(),
		error: z.string().nullish(),
		metrics: z.object({ predict_time: z.number().optional() }).optional(),
		created_at: z.string().optional(),
		started_at: z.string().nullish(),
		completed_at: z.string().nullish(),
	})
	.passthrough();
export interface ReplicateProviderOptions extends HttpClientOptions {
	apiToken: string;
	webhookSecret?: string;
	baseUrl?: string;
	webhookToleranceSeconds?: number;
	now?: () => number;
}
export class ReplicateProviderAdapter implements MediaProviderAdapter {
	readonly provider = "replicate" as const;
	private readonly snapshots = new Map<string, ProviderTaskSnapshot>();
	constructor(private readonly options: ReplicateProviderOptions) {}
	async submit(input: ProviderSubmitInput): Promise<ProviderSubmission> {
		const { ok, status, data } = await fetchJson(
			`${this.options.baseUrl ?? "https://api.replicate.com/v1"}/predictions`,
			{
				method: "POST",
				headers: this.headers(input.attemptId),
				body: JSON.stringify({
					version: input.providerModelId,
					input: mapInput(input.input),
					webhook: input.webhookUrl,
					webhook_events_filter: input.webhookUrl ? ["start", "completed"] : undefined,
				}),
			},
			this.options,
		);
		if (!ok) return rejectedHttpSubmission({ status, data, attemptId: input.attemptId });
		const parsed = responseSchema.safeParse(data);
		if (!parsed.success)
			throw new MediaProviderError(
				"MALFORMED_PROVIDER_RESPONSE",
				"Replicate response was malformed",
				false,
			);
		const snapshot = toSnapshot(parsed.data);
		this.snapshots.set(parsed.data.id, snapshot);
		return {
			providerTaskId: parsed.data.id,
			status: snapshot.status,
			idempotency: { key: input.attemptId, providerSupported: true, replayed: false },
			outcome: "accepted",
			reconciliation: { submissionToken: input.attemptId },
			snapshot,
		};
	}
	async retrieve(input: ProviderRetrieveInput): Promise<ProviderTaskSnapshot> {
		const { ok, data } = await fetchJson(
			`${this.options.baseUrl ?? "https://api.replicate.com/v1"}/predictions/${encodeURIComponent(input.providerTaskId)}`,
			{ headers: this.headers() },
			this.options,
		);
		if (!ok) return { providerTaskId: input.providerTaskId, status: "UNKNOWN", raw: data };
		const parsed = responseSchema.safeParse(data);
		if (!parsed.success)
			throw new MediaProviderError(
				"MALFORMED_PROVIDER_RESPONSE",
				"Replicate response was malformed",
				false,
			);
		const snapshot = toSnapshot(parsed.data);
		this.snapshots.set(parsed.data.id, snapshot);
		return snapshot;
	}
	async cancel(input: ProviderCancelInput): Promise<ProviderCancelResult> {
		const { ok } = await fetchJson(
			`${this.options.baseUrl ?? "https://api.replicate.com/v1"}/predictions/${encodeURIComponent(input.providerTaskId)}/cancel`,
			{ method: "POST", headers: this.headers() },
			this.options,
		);
		return { status: ok ? "CANCELED" : "UNKNOWN", canceled: ok };
	}
	async verifyWebhook(request: Request): Promise<VerifiedProviderEvent> {
		if (!this.options.webhookSecret)
			throw new MediaProviderError(
				"WEBHOOK_VERIFICATION_FAILED",
				"Webhook secret is not configured",
				false,
			);
		const body = await request.text();
		const webhookId = request.headers.get("webhook-id") ?? "";
		const timestampHeader = request.headers.get("webhook-timestamp") ?? "";
		const signatureHeader = request.headers.get("webhook-signature") ?? "";
		const timestamp = Number(timestampHeader);
		const nowSeconds = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
		if (
			!webhookId ||
			!Number.isSafeInteger(timestamp) ||
			Math.abs(nowSeconds - timestamp) > (this.options.webhookToleranceSeconds ?? 300)
		)
			throw new MediaProviderError(
				"WEBHOOK_VERIFICATION_FAILED",
				"Invalid or stale webhook timestamp",
				false,
			);
		const secret = this.options.webhookSecret.startsWith("whsec_")
			? this.options.webhookSecret.slice(6)
			: "";
		let key: Buffer;
		try {
			key = Buffer.from(secret, "base64");
		} catch {
			key = Buffer.alloc(0);
		}
		if (!secret || key.length === 0)
			throw new MediaProviderError("WEBHOOK_VERIFICATION_FAILED", "Invalid webhook secret", false);
		const expected = createHmac("sha256", key)
			.update(`${webhookId}.${timestampHeader}.${body}`)
			.digest();
		const isValid = signatureHeader.split(/\s+/).some((signature) => {
			const [version, encoded] = signature.split(",", 2);
			if (version !== "v1" || !encoded) return false;
			let candidate: Buffer;
			try {
				candidate = Buffer.from(encoded, "base64");
			} catch {
				return false;
			}
			return candidate.length === expected.length && timingSafeEqual(candidate, expected);
		});
		if (!isValid)
			throw new MediaProviderError(
				"WEBHOOK_VERIFICATION_FAILED",
				"Invalid webhook signature",
				false,
			);
		const parsed = responseSchema.safeParse(JSON.parse(body));
		if (!parsed.success)
			throw new MediaProviderError(
				"MALFORMED_PROVIDER_RESPONSE",
				"Replicate webhook was malformed",
				false,
			);
		return {
			eventId: webhookId,
			providerTaskId: parsed.data.id,
			status: normalizeStatus(parsed.data.status),
			receivedAt: new Date(),
			providerOccurredAt: replicateEventTime(parsed.data),
		};
	}
	async normalizeResult(snapshot: ProviderTaskSnapshot): Promise<NormalizedResult> {
		const parsed = responseSchema.safeParse(snapshot.raw);
		if (!parsed.success)
			throw new MediaProviderError(
				"MALFORMED_PROVIDER_RESPONSE",
				"Replicate response was malformed",
				false,
			);
		const values = parsed.data.output
			? Array.isArray(parsed.data.output)
				? parsed.data.output
				: [parsed.data.output]
			: [];
		const cost =
			parsed.data.metrics?.predict_time !== undefined
				? Math.round(parsed.data.metrics.predict_time * 1_000)
				: null;
		return normalizedResult(
			snapshot,
			remoteOutputs(values),
			failureFrom(parsed.data.error ?? undefined),
			cost,
		);
	}
	private headers(idempotencyKey?: string): Record<string, string> {
		return {
			Authorization: `Bearer ${this.options.apiToken}`,
			"Content-Type": "application/json",
			...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
		};
	}
}
function toSnapshot(data: z.infer<typeof responseSchema>): ProviderTaskSnapshot {
	return { providerTaskId: data.id, status: normalizeStatus(data.status), raw: data };
}

function replicateEventTime(data: z.infer<typeof responseSchema>): Date | undefined {
	for (const value of [data.completed_at, data.started_at, data.created_at]) {
		if (!value) continue;
		const timestamp = new Date(value);
		if (!Number.isNaN(timestamp.getTime())) return timestamp;
	}
	return undefined;
}
function mapInput(input: ProviderSubmitInput["input"]): Record<string, unknown> {
	return {
		prompt: input.prompt,
		...("sourceAsset" in input ? { image: input.sourceAsset.transferUrl } : {}),
		...(input.kind === "text-to-image" ? { width: input.width, height: input.height } : {}),
		...(input.kind === "image-to-image" ? { strength: input.strength } : {}),
		...(input.kind.includes("video") && "durationSeconds" in input
			? { duration: input.durationSeconds }
			: {}),
	};
}
