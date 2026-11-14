import { z } from "zod";

export const SEEAPI_TEXT_SAFETY_RULE_VERSION = "seeapi-text-waffo-fallback-2026-11-15.1";
export const SEEAPI_TEXT_CATEGORIES = [
	"sexual_explicit",
	"sexual_suggestive",
	"sexual_minors",
	"violence",
	"hate",
	"harassment",
	"self_harm",
] as const;
export const seeapiTextResultSchema = z
	.object({
		flagged: z.boolean(),
		threshold: z.literal(0.3),
		categories: z.record(
			z.enum(SEEAPI_TEXT_CATEGORIES),
			z.object({
				score: z.number().min(0).max(1),
				flagged: z.boolean(),
			}),
		),
	})
	.refine(
		(value) =>
			value.flagged === Object.values(value.categories).some((category) => category.flagged),
	)
	.refine((value) =>
		Object.values(value.categories).every(
			(category) => category.flagged === category.score >= value.threshold,
		),
	);

export const waffoTextApprovalSchema = z.object({
	requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
	action: z.literal("allow"),
	semanticStatus: z.literal("scored"),
	matchedCategories: z.array(z.string()).length(0),
});

/** Only technical failures permit an independent text scan; content decisions never do. */
export const TEXT_FALLBACK_ERROR_CODES = [
	"MODERATION_RATE_LIMITED",
	"MODERATION_TIMEOUT",
	"MODERATION_NETWORK_ERROR",
	"MODERATION_SERVICE_ERROR",
	"MODERATION_INVALID_RESPONSE",
	"MODERATION_UNAVAILABLE",
] as const;
export function permitsTextModerationFallback(code: string) {
	return TEXT_FALLBACK_ERROR_CODES.some((value) => value === code);
}
