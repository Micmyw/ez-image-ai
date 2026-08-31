import { z } from "zod";

import { MediaProviderError } from "../errors";
import type {
	NormalizedResult,
	ProviderRetrieveInput,
	ProviderSubmission,
	ProviderSubmitInput,
	ProviderTaskSnapshot,
} from "../types";
import { normalizedResult } from "./common";
import { fetchJson, rejectedHttpSubmission, type HttpClientOptions } from "./http";
import type { MediaProviderAdapter } from "./provider-adapter";

const DEFAULT_OPENROUTER_URL = "https://openrouter.ai";
export const OPENROUTER_IMAGE_REQUEST_TIMEOUT_MS = 240_000;
const openRouterImageResponseSchema = z
	.object({
		data: z.array(z.object({ b64_json: z.string().min(1) }).passthrough()),
	})
	.passthrough();

export interface OpenRouterProviderOptions extends HttpClientOptions {
	apiKey: string;
	baseUrl?: string;
}

export class OpenRouterProviderAdapter implements MediaProviderAdapter {
	readonly provider = "openrouter" as const;

	constructor(private readonly options: OpenRouterProviderOptions) {}

	async submit(input: ProviderSubmitInput): Promise<ProviderSubmission> {
		if (input.input.kind !== "image-to-image" || !("sourceAsset" in input.input)) {
			throw new MediaProviderError(
				"UNSUPPORTED_INPUT",
				"OpenRouter image routes require a resolved source image",
				false,
			);
		}
		const { ok, status, data } = await fetchJson(
			`${this.options.baseUrl ?? DEFAULT_OPENROUTER_URL}/api/v1/images`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.options.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: input.providerModelId,
					prompt: input.input.prompt,
					n: 1,
					input_references: [
						{
							type: "image_url",
							image_url: { url: input.input.sourceAsset.transferUrl },
						},
					],
				}),
			},
			{
				...this.options,
				timeoutMs: this.options.timeoutMs ?? OPENROUTER_IMAGE_REQUEST_TIMEOUT_MS,
			},
		);
		if (!ok) {
			return rejectedHttpSubmission({
				status,
				data,
				attemptId: input.attemptId,
				providerIdempotencySupported: false,
			});
		}

		const parsed = parseSingleRasterOutput(data);
		if (!parsed) return malformedSubmission(input.attemptId);
		const snapshot: ProviderTaskSnapshot = {
			providerTaskId: input.attemptId,
			status: "SUCCEEDED",
			progress: 100,
			raw: data,
		};
		return {
			providerTaskId: input.attemptId,
			status: "SUCCEEDED",
			outcome: "accepted",
			idempotency: { providerSupported: false, replayed: false },
			reconciliation: { submissionToken: input.attemptId },
			snapshot,
		};
	}

	async retrieve(input: ProviderRetrieveInput): Promise<ProviderTaskSnapshot> {
		return { providerTaskId: input.providerTaskId, status: "UNKNOWN", raw: null };
	}

	async normalizeResult(snapshot: ProviderTaskSnapshot): Promise<NormalizedResult> {
		const output = parseSingleRasterOutput(snapshot.raw);
		if (!output) {
			throw new MediaProviderError(
				"MALFORMED_PROVIDER_RESPONSE",
				"OpenRouter image response was malformed",
				false,
			);
		}
		return normalizedResult(
			snapshot,
			[
				{
					kind: "inline-base64",
					mimeType: output.mimeType,
					data: output.data,
					trust: "untrusted-transfer-candidate",
				},
			],
			null,
			null,
		);
	}
}

function malformedSubmission(attemptId: string): ProviderSubmission {
	return {
		status: "SUCCEEDED",
		outcome: "uncertain",
		uncertainty: { classification: "malformed_2xx", phase: "post_send" },
		idempotency: { providerSupported: false, replayed: false },
		reconciliation: { submissionToken: attemptId },
	};
}

function parseSingleRasterOutput(
	value: unknown,
): { data: string; mimeType: "image/jpeg" | "image/png" | "image/webp" } | null {
	const parsed = openRouterImageResponseSchema.safeParse(value);
	if (!parsed.success || parsed.data.data.length !== 1) return null;
	const data = parsed.data.data[0]!.b64_json;
	if (!isCanonicalBase64(data)) return null;
	const bytes = Buffer.from(data, "base64");
	const mimeType = rasterMimeType(bytes);
	return mimeType ? { data, mimeType } : null;
}

function isCanonicalBase64(value: string): boolean {
	if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
	return Buffer.from(value, "base64").toString("base64") === value;
}

function rasterMimeType(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return "image/png";
	}
	if (
		startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
		bytes.length >= 12 &&
		startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
	) {
		return "image/webp";
	}
	return null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
	return signature.every((value, index) => bytes[index] === value);
}
