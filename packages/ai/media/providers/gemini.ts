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

const geminiSchema = z.object({
	candidates: z
		.array(
			z.object({
				content: z.object({
					parts: z.array(
						z.object({
							inlineData: z.object({ mimeType: z.string(), data: z.string().min(1) }).optional(),
							text: z.string().optional(),
						}),
					),
				}),
			}),
		)
		.min(1),
});
export interface GeminiProviderOptions extends HttpClientOptions {
	apiKey: string;
	baseUrl?: string;
}
export class GeminiProviderAdapter implements MediaProviderAdapter {
	readonly provider = "gemini" as const;
	constructor(private readonly options: GeminiProviderOptions) {}
	async submit(input: ProviderSubmitInput): Promise<ProviderSubmission> {
		const { ok, status, data } = await fetchJson(
			`${this.options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta/models"}/${input.providerModelId}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Request-Id": input.attemptId },
				body: JSON.stringify({ contents: [{ parts: mapGeminiParts(input.input) }] }),
			},
			this.options,
		);
		if (!ok)
			return rejectedHttpSubmission({
				status,
				data,
				attemptId: input.attemptId,
				providerIdempotencySupported: false,
			});
		const parsed = this.parse(data);
		const snapshot = {
			providerTaskId: input.attemptId,
			status: "SUCCEEDED" as const,
			progress: 100,
			raw: parsed,
		};
		const hasMedia = parsed.candidates.some((candidate) =>
			candidate.content.parts.some((part) => part.inlineData !== undefined),
		);
		if (!hasMedia) {
			return {
				status: "SUCCEEDED",
				outcome: "uncertain",
				uncertainty: { classification: "malformed_2xx", phase: "post_send" },
				idempotency: { providerSupported: false, replayed: false },
				reconciliation: { submissionToken: input.attemptId },
			};
		}
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
		const parsed = this.parse(snapshot.raw);
		const outputs = parsed.candidates.flatMap((candidate) =>
			candidate.content.parts.flatMap((part) =>
				part.inlineData
					? [
							{
								kind: "inline-base64" as const,
								mimeType: part.inlineData.mimeType,
								data: part.inlineData.data,
								trust: "untrusted-transfer-candidate" as const,
							},
						]
					: [],
			),
		);
		return normalizedResult(snapshot, outputs, null, null);
	}
	private parse(data: unknown): z.infer<typeof geminiSchema> {
		const parsed = geminiSchema.safeParse(data);
		if (!parsed.success)
			throw new MediaProviderError(
				"MALFORMED_PROVIDER_RESPONSE",
				"Gemini response was malformed",
				false,
			);
		return parsed.data;
	}
}

function mapGeminiParts(input: ProviderSubmitInput["input"]): Array<Record<string, unknown>> {
	const parts: Array<Record<string, unknown>> = [{ text: input.prompt }];
	if ("sourceAsset" in input) {
		const match = /^data:([^;]+);base64,(.+)$/.exec(input.sourceAsset.transferUrl);
		if (!match) throw new Error("Gemini resolved source asset must be an inline data URL");
		parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
	}
	return parts;
}
