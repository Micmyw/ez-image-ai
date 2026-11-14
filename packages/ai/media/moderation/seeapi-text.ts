import {
	moderationHttpErrorCode,
	moderationServiceErrorCode,
	permitsTextModerationFallback,
	seeapiTextResultSchema,
	waffoTextApprovalSchema,
} from "@repo/config";
import { z } from "zod";

import { fetchJson, type HttpClientOptions } from "../providers/http";
import type { ModerateTextInput, ModerationDecision, ModerationEvidence } from "./types";

const taskSchema = z.object({
	id: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
	object: z.literal("inference"),
	model: z.literal("text-nsfw-filter"),
	endpoint: z.literal("text-moderation"),
	provider: z.literal("seeapi"),
	status: z.enum([
		"queued",
		"processing",
		"succeeded",
		"failed",
		"canceled",
		"refunded",
		"expired",
	]),
	result: z.unknown(),
	error: z.object({ code: z.string() }).nullable(),
});

export type WaffoFallbackScanner = (text: string) => Promise<{
	decision: ModerationDecision["decision"];
	reasonCode: string;
	evidence?: ModerationEvidence["waffo"];
}>;

export function waffoTextDecision(
	result: Awaited<ReturnType<WaffoFallbackScanner>>,
	ruleVersion: string,
): ModerationDecision {
	if (
		result.decision === "ALLOW" &&
		(result.reasonCode !== "WAFFO_PROMPT_ALLOWED" ||
			!waffoTextApprovalSchema.safeParse(result.evidence).success)
	) {
		return { decision: "ERROR", reasonCode: "MODERATION_INVALID_RESPONSE", ruleVersion };
	}
	return {
		decision: result.decision,
		reasonCode: result.reasonCode,
		ruleVersion,
		...(result.evidence
			? {
					evidence: {
						requestId: result.evidence.requestId,
						models: ["waffo-prompt-sift"],
						operations: 1,
						scores: {},
						waffo: result.evidence,
					},
				}
			: {}),
	};
}

/** Restrictive signals outrank malformed envelopes and never trigger fallback. */
function hasRestrictiveSignal(raw: unknown): boolean {
	const result = z
		.object({
			result: z.object({
				data: z.object({
					flagged: z.unknown().optional(),
					categories: z.unknown().optional(),
				}),
			}),
		})
		.safeParse(raw);
	if (!result.success) return false;
	const data = result.data.result.data;
	const categories = z.record(z.string(), z.unknown()).safeParse(data.categories);
	return (
		data.flagged === true ||
		Object.values(categories.success ? categories.data : {}).some((value) => {
			const category = z
				.object({ flagged: z.unknown().optional(), score: z.unknown().optional() })
				.safeParse(value);
			return (
				category.success &&
				(category.data.flagged === true ||
					(typeof category.data.score === "number" && category.data.score >= 0.3))
			);
		})
	);
}

/** One scanner per request. Retries keep the same accepted task or submission key. */
export function createSeeapiTextScanner(
	options: HttpClientOptions & { apiKey: string; fallbackScan: WaffoFallbackScanner },
) {
	const attempts = new Map<string, { key: string; taskId?: string }>();
	async function request(path: string, init: RequestInit) {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${options.apiKey}`);
		headers.set("Content-Type", "application/json");
		const response = await fetchJson(
			`https://api.seeapi.com${path}`,
			{
				...init,
				redirect: "manual",
				headers,
			},
			{ ...options, maxResponseBytes: 64 * 1024, timeoutMs: options.timeoutMs ?? 10_000 },
		);
		if (!response.ok) {
			if (hasRestrictiveSignal(response.data)) throw new Error("SEEAPI_TEXT_REVIEW_REQUIRED");
			throw new Error(moderationHttpErrorCode(response.status));
		}
		return response.data;
	}
	return async (input: ModerateTextInput): Promise<ModerationDecision> => {
		const error = (reasonCode: string): ModerationDecision => ({
			decision: "ERROR",
			reasonCode,
			ruleVersion: input.ruleVersion,
		});
		if (!input.text.trim() || input.text.length > 10_000) return error("MODERATION_INVALID_INPUT");
		if (!options.apiKey.trim()) return error("MODERATION_CONFIGURATION_ERROR");
		const identity = JSON.stringify([input.idempotencyKey, input.ruleVersion, input.text]);
		let attempt = attempts.get(identity);
		if (!attempt) {
			attempt = { key: input.idempotencyKey ?? `text-review-${crypto.randomUUID()}` };
			attempts.set(identity, attempt);
		}
		let primary: ModerationDecision;
		let restrictive = false;
		const review = (): ModerationDecision => ({
			decision: "REVIEW",
			reasonCode: "SEEAPI_TEXT_REVIEW_REQUIRED",
			ruleVersion: input.ruleVersion,
		});
		try {
			let raw = await request(
				attempt.taskId ? `/v1/inferences/${encodeURIComponent(attempt.taskId)}` : "/v1/inferences",
				attempt.taskId
					? { method: "GET" }
					: {
							method: "POST",
							headers: { "Idempotency-Key": attempt.key },
							body: JSON.stringify({
								model: "text-nsfw-filter",
								endpoint: "text-moderation",
								provider: "seeapi",
								input: { text: input.text, threshold: 0.3 },
							}),
						},
			);
			restrictive = hasRestrictiveSignal(raw);
			let task = taskSchema.parse(raw);
			if (attempt.taskId && task.id !== attempt.taskId)
				throw new Error("MODERATION_INVALID_RESPONSE");
			attempt.taskId = task.id;
			if (["queued", "processing"].includes(task.status)) {
				if (restrictive) return review();
				raw = await request(`/v1/inferences/${encodeURIComponent(task.id)}`, { method: "GET" });
				restrictive = hasRestrictiveSignal(raw);
				task = taskSchema.parse(raw);
				if (task.id !== attempt.taskId) throw new Error("MODERATION_INVALID_RESPONSE");
			}
			if (["queued", "processing"].includes(task.status)) {
				// A pending assessment is not a technical failure or permission to switch provider.
				return restrictive ? review() : error("MODERATION_SUBMISSION_UNCERTAIN");
			}
			if (task.status === "succeeded") {
				const envelope = z
					.object({ type: z.literal("json"), data: z.unknown() })
					.parse(task.result);
				// Preserve a restrictive signal even when the rest of its result is malformed.
				const result = seeapiTextResultSchema.safeParse(envelope.data);
				if (!result.success) {
					if (restrictive) return review();
					throw new Error("MODERATION_INVALID_RESPONSE");
				}
				if (task.error !== null) throw new Error("MODERATION_INVALID_RESPONSE");
				return {
					decision: result.data.flagged ? "REJECT" : "ALLOW",
					reasonCode: result.data.flagged
						? "SEEAPI_TEXT_CONTENT_NOT_ALLOWED"
						: "SEEAPI_TEXT_ALLOWED",
					ruleVersion: input.ruleVersion,
					evidence: {
						requestId: task.id,
						models: ["text-nsfw-filter"],
						operations: 1,
						scores: Object.fromEntries(
							Object.entries(result.data.categories).map(([key, value]) => [key, value.score]),
						),
						seeapiText: { taskId: task.id, model: "text-nsfw-filter", ...result.data },
					},
				};
			}
			if (restrictive) return review();
			const technical: Record<string, string> = {
				RATE_LIMITED: "MODERATION_RATE_LIMITED",
				PROVIDER_TIMEOUT: "MODERATION_TIMEOUT",
				DETECTION_REPORT_FAILED: "MODERATION_SERVICE_ERROR",
				PROVIDER_ERROR: "MODERATION_SERVICE_ERROR",
				INTERNAL_ERROR: "MODERATION_SERVICE_ERROR",
			};
			const reason = task.status === "failed" && task.error && technical[task.error.code];
			if (!reason) return error("SEEAPI_TEXT_TERMINAL_UNCLASSIFIED");
			primary = error(reason);
		} catch (cause) {
			if (
				restrictive ||
				(cause instanceof Error && cause.message === "SEEAPI_TEXT_REVIEW_REQUIRED")
			)
				return review();
			primary = error(moderationServiceErrorCode(cause));
		}
		if (!permitsTextModerationFallback(primary.reasonCode)) return primary;
		try {
			const fallback = waffoTextDecision(await options.fallbackScan(input.text), input.ruleVersion);
			return {
				...fallback,
				...(fallback.evidence
					? {
							evidence: {
								...fallback.evidence,
								textFallback: {
									primaryProvider: "seeapi",
									primaryReasonCode: primary.reasonCode,
									...(attempt.taskId ? { primaryTaskId: attempt.taskId } : {}),
									fallbackProvider: "waffo",
								},
							},
						}
					: {}),
			};
		} catch {
			return error("MODERATION_UNAVAILABLE");
		}
	};
}
