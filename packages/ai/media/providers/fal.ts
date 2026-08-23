import { z } from "zod";

import { MediaProviderError } from "../errors";
import type {
	NormalizedResult,
	ProviderRetrieveInput,
	ProviderSubmission,
	ProviderSubmitInput,
	ProviderTaskSnapshot,
} from "../types";
import { failureFrom, normalizedResult, normalizeStatus, remoteOutputs } from "./common";
import { fetchJson, rejectedHttpSubmission, type HttpClientOptions } from "./http";
import type { MediaProviderAdapter } from "./provider-adapter";

const DEFAULT_FAL_QUEUE_URL = "https://queue.fal.run";

const falSchema = z
	.object({
		request_id: z.string().min(1),
		status: z.string().optional(),
		status_url: z.string().optional(),
		response_url: z.string().optional(),
		images: z.array(z.object({ url: z.string() })).optional(),
		video: z.object({ url: z.string() }).optional(),
		error: z.string().optional(),
	})
	.passthrough();
export interface FalProviderOptions extends HttpClientOptions {
	apiKey: string;
	queueUrl?: string;
}
export class FalProviderAdapter implements MediaProviderAdapter {
	readonly provider = "fal" as const;
	constructor(private readonly options: FalProviderOptions) {}
	async submit(input: ProviderSubmitInput): Promise<ProviderSubmission> {
		const queueUrl = this.options.queueUrl ?? DEFAULT_FAL_QUEUE_URL;
		const authenticatedHostname = falAuthenticatedHostname(queueUrl);
		const { ok, status, data } = await fetchJson(
			assertFalAuthenticatedUrl(`${queueUrl}/${input.providerModelId}`, authenticatedHostname),
			{
				method: "POST",
				headers: this.headers(input.attemptId),
				redirect: "error",
				body: JSON.stringify({
					prompt: input.input.prompt,
					...("sourceAsset" in input.input
						? { image_url: input.input.sourceAsset.transferUrl }
						: {}),
					...("durationSeconds" in input.input ? { duration: input.input.durationSeconds } : {}),
				}),
			},
			this.options,
		);
		if (!ok) return rejectedHttpSubmission({ status, data, attemptId: input.attemptId });
		const parsed = this.parse(data);
		const statusUrl = optionalFalAuthenticatedUrl(parsed.status_url, authenticatedHostname);
		const resultUrl = optionalFalAuthenticatedUrl(parsed.response_url, authenticatedHostname);
		const normalizedStatus = normalizeStatus(parsed.status ?? "queued");
		const terminalWithoutOutput =
			normalizedStatus === "SUCCEEDED" && !parsed.images?.length && !parsed.video?.url;
		const reconciliation = {
			submissionToken: input.attemptId,
			statusUrl,
			resultUrl,
		};
		const snapshot = {
			providerTaskId: parsed.request_id,
			status: normalizedStatus,
			raw: parsed,
		};
		if (terminalWithoutOutput) {
			return {
				providerTaskId: parsed.request_id,
				status: normalizedStatus,
				outcome: "uncertain",
				uncertainty: { classification: "malformed_2xx", phase: "post_send" },
				idempotency: { key: input.attemptId, providerSupported: true, replayed: false },
				reconciliation,
				snapshot,
			};
		}
		return {
			providerTaskId: parsed.request_id,
			status: normalizedStatus,
			outcome: "accepted",
			idempotency: { key: input.attemptId, providerSupported: true, replayed: false },
			reconciliation,
			snapshot,
		};
	}
	async retrieve(input: ProviderRetrieveInput): Promise<ProviderTaskSnapshot> {
		const url = input.resultUrl ?? input.statusUrl;
		if (!url) throw new Error("Fal retrieval requires the stored status or result endpoint");
		const authenticatedUrl = assertFalAuthenticatedUrl(
			url,
			falAuthenticatedHostname(this.options.queueUrl ?? DEFAULT_FAL_QUEUE_URL),
		);
		const { ok, data } = await fetchJson(
			authenticatedUrl,
			{ headers: this.headers(), redirect: "error" },
			this.options,
		);
		if (!ok) return { providerTaskId: input.providerTaskId, status: "UNKNOWN", raw: data };
		const parsed = this.parse(data);
		return {
			providerTaskId: parsed.request_id,
			status: normalizeStatus(
				parsed.status ?? (parsed.images || parsed.video ? "succeeded" : "unknown"),
			),
			raw: parsed,
		};
	}
	async normalizeResult(snapshot: ProviderTaskSnapshot): Promise<NormalizedResult> {
		const parsed = this.parse(snapshot.raw);
		const urls = [
			...(parsed.images?.map((image) => image.url) ?? []),
			...(parsed.video ? [parsed.video.url] : []),
		];
		return normalizedResult(snapshot, remoteOutputs(urls), failureFrom(parsed.error), null);
	}
	private parse(data: unknown): z.infer<typeof falSchema> {
		const parsed = falSchema.safeParse(data);
		if (!parsed.success)
			throw new MediaProviderError(
				"MALFORMED_PROVIDER_RESPONSE",
				"Fal response was malformed",
				false,
			);
		return parsed.data;
	}
	private headers(idempotency?: string): Record<string, string> {
		return {
			Authorization: `Key ${this.options.apiKey}`,
			"Content-Type": "application/json",
			...(idempotency ? { "X-Fal-Idempotency-Key": idempotency } : {}),
		};
	}
}

function optionalFalAuthenticatedUrl(
	value: string | undefined,
	hostname: string,
): string | undefined {
	return value === undefined ? undefined : assertFalAuthenticatedUrl(value, hostname);
}

function falAuthenticatedHostname(queueUrl: string): string {
	const parsed = parseFalAuthenticatedUrl(queueUrl);
	return parsed.hostname;
}

function assertFalAuthenticatedUrl(value: string, hostname: string): string {
	const parsed = parseFalAuthenticatedUrl(value);
	if (parsed.hostname !== hostname) throw unsafeFalEndpointError();
	return value;
}

function parseFalAuthenticatedUrl(value: string): URL {
	if (value !== value.trim()) throw unsafeFalEndpointError();

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw unsafeFalEndpointError();
	}

	const authority = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value)?.[1];
	if (
		parsed.protocol !== "https:" ||
		!authority ||
		authority.toLowerCase() !== parsed.hostname ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.port !== ""
	) {
		throw unsafeFalEndpointError();
	}

	return parsed;
}

function unsafeFalEndpointError(): MediaProviderError {
	return new MediaProviderError(
		"MALFORMED_PROVIDER_RESPONSE",
		"Fal response contained an unsafe authenticated endpoint",
		false,
	);
}
