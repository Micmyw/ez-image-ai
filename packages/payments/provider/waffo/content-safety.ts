import { ScanSemanticMode, WaffoPancake } from "@waffo/pancake-ts";
import { z } from "zod";

const verdictSchema = z.object({
	action: z.enum(["allow", "review", "block"]),
	reasonCode: z.enum(["allowed", "review_required", "restricted_content", "service_degraded"]),
	matchedCategories: z
		.array(
			z.enum([
				"csam_minor",
				"sexual_violence_nonconsensual",
				"undress_transform",
				"face_swap_identity",
				"bestiality_restricted",
				"adult_nsfw",
			]),
		)
		.max(6),
	requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
	semanticStatus: z.enum([
		"disabled",
		"scored",
		"shadow_scored",
		"skipped_rules_block",
		"skipped_budget",
		"provider_timeout",
		"provider_error",
	]),
	warnings: z.array(z.unknown()).optional(),
});

export interface WaffoPromptEvidence {
	requestId: string;
	action: "allow" | "review" | "block";
	semanticStatus: string;
	matchedCategories: string[];
}

export interface WaffoPromptDecision {
	decision: "ALLOW" | "REJECT" | "REVIEW" | "ERROR";
	reasonCode: string;
	evidence?: WaffoPromptEvidence;
}

export function createWaffoPromptScanner(environment: Record<string, string | undefined>) {
	// This is a merchant-signed verification action, independent of checkout sessions
	// and payment webhook verification. It always uses the documented API origin.
	const merchantId = environment.WAFFO_MERCHANT_ID?.trim();
	const privateKey = environment.WAFFO_PRIVATE_KEY?.trim();
	if (!merchantId || !privateKey) throw new Error("WAFFO_CONFIGURATION_INCOMPLETE");
	const client = new WaffoPancake({ merchantId, privateKey, fetch: fetchPromptScan });
	return async (prompt: string): Promise<WaffoPromptDecision> => {
		if (!prompt.trim() || prompt.length > 10_000) {
			return { decision: "ERROR", reasonCode: "MODERATION_INVALID_INPUT" };
		}
		try {
			const verdict = verdictSchema.parse(
				await client.contentSafety.scanPrompt({
					prompt,
					locale: "en",
					semantic: ScanSemanticMode.Enforce,
				}),
			);
			if (verdict.warnings?.length) throw new Error("WAFFO_PROMPT_SCAN_WARNING");
			const evidence: WaffoPromptEvidence = {
				requestId: verdict.requestId,
				action: verdict.action,
				semanticStatus: verdict.semanticStatus,
				matchedCategories: verdict.matchedCategories,
			};
			if (verdict.action === "allow") {
				if (
					verdict.reasonCode !== "allowed" ||
					verdict.matchedCategories.length ||
					verdict.semanticStatus !== "scored"
				) {
					throw new Error("WAFFO_PROMPT_SCAN_INCOMPLETE");
				}
				return { decision: "ALLOW", reasonCode: "WAFFO_PROMPT_ALLOWED", evidence };
			}
			if (verdict.action === "block" && verdict.reasonCode === "restricted_content") {
				return { decision: "REJECT", reasonCode: "WAFFO_RESTRICTED_CONTENT", evidence };
			}
			if (verdict.action === "review" && verdict.reasonCode === "review_required") {
				return { decision: "REVIEW", reasonCode: "WAFFO_REVIEW_REQUIRED", evidence };
			}
			return { decision: "ERROR", reasonCode: "MODERATION_UNAVAILABLE", evidence };
		} catch {
			return { decision: "ERROR", reasonCode: "MODERATION_UNAVAILABLE" };
		}
	};
}

// The SDK unwraps data independently of HTTP status. Require a successful,
// bounded response before it can interpret a verdict; never follow signed redirects.
const MAX_PROMPT_SCAN_RESPONSE_BYTES = 64 * 1024;
const fetchPromptScan: typeof fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.href !== "https://api.waffo.ai/v1/actions/verification/scan-prompt") {
		throw new Error("WAFFO_PROMPT_SCAN_ORIGIN_INVALID");
	}
	// The stateless scan must not reuse the SDK's prompt-derived idempotency cache:
	// an identical prompt still needs a fresh verdict after a policy change.
	const headers = new Headers(init?.headers);
	headers.delete("x-idempotency-key");
	const response = await fetch(input, {
		...init,
		headers,
		// Workers supports manual redirects; reject every non-2xx response below.
		redirect: "manual",
		signal: init?.signal
			? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
			: AbortSignal.timeout(15_000),
	});
	if (
		!response.ok ||
		Number(response.headers.get("content-length")) > MAX_PROMPT_SCAN_RESPONSE_BYTES
	) {
		void response.body?.cancel().catch(() => undefined);
		throw new Error("WAFFO_PROMPT_SCAN_RESPONSE_INVALID");
	}
	if (!response.body) throw new Error("WAFFO_PROMPT_SCAN_RESPONSE_EMPTY");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_PROMPT_SCAN_RESPONSE_BYTES) {
				void reader.cancel().catch(() => undefined);
				throw new Error("WAFFO_PROMPT_SCAN_RESPONSE_TOO_LARGE");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new Response(bytes, { status: response.status });
};
