import { z } from "zod";

export const VIDEO_TEXT_SAFETY_RULE_VERSION = "waffo-prompt-safety-2026-10-04.1";
export const videoTextSafetyProfileSchema = z
	.object({
		schemaVersion: z.literal(1),
		provider: z.literal("waffo"),
		ruleVersion: z.literal(VIDEO_TEXT_SAFETY_RULE_VERSION),
		semantic: z.literal("enforce"),
	})
	.strict();
export type VideoTextSafetyProfile = z.infer<typeof videoTextSafetyProfileSchema>;

export function createVideoTextSafetyProfile(): VideoTextSafetyProfile {
	return {
		schemaVersion: 1,
		provider: "waffo",
		ruleVersion: VIDEO_TEXT_SAFETY_RULE_VERSION,
		semantic: "enforce",
	};
}

export function configuredVideoTextSafetyProfile(
	environment: Record<string, string | undefined>,
): VideoTextSafetyProfile {
	if (environment.VIDEO_V1_TEXT_SAFETY_ADAPTER !== "waffo")
		throw new Error("VIDEO_TEXT_MODERATION_NOT_CONFIGURED");
	return createVideoTextSafetyProfile();
}

/** Historical evidence is retained, but missing profiles never authorize a new paid call. */
export function readVideoTextSafetyProfile(snapshot: unknown): VideoTextSafetyProfile {
	const parsed = z.object({ textSafetyProfile: videoTextSafetyProfileSchema }).safeParse(snapshot);
	if (!parsed.success) throw new Error("VIDEO_TEXT_SAFETY_PROFILE_INVALID");
	return parsed.data.textSafetyProfile;
}

export function videoTextSafetyProfilesMatch(
	value: unknown,
	profile: VideoTextSafetyProfile,
): boolean {
	const parsed = videoTextSafetyProfileSchema.safeParse(value);
	return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(profile);
}

/** The send fence independently validates the complete, fail-closed Waffo approval. */
export function isApprovedVideoTextDecision(
	value: unknown,
	profile: VideoTextSafetyProfile,
): boolean {
	const parsed = z
		.object({
			decision: z.literal("ALLOW"),
			reasonCode: z.literal("WAFFO_PROMPT_ALLOWED"),
			ruleVersion: z.literal(profile.ruleVersion),
			evidence: z.object({
				requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
				models: z.tuple([z.literal("waffo-prompt-sift")]),
				operations: z.literal(1),
				waffo: z.object({
					requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
					action: z.literal("allow"),
					semanticStatus: z.literal("scored"),
					matchedCategories: z.array(z.string()).length(0),
				}),
			}),
		})
		.safeParse(value);
	return parsed.success && parsed.data.evidence.requestId === parsed.data.evidence.waffo.requestId;
}
