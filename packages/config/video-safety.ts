import { z } from "zod";

// Historical identifiers remain readable for audit; retired providers cannot run.
const coverage = {
	maxFirstFrameMillis: z.literal(250),
	maxLastFrameGapMillis: z.literal(1000),
	maxEndOverrunMillis: z.literal(500),
	maxFrameGapMillis: z.literal(1000),
};
export const videoVisualSafetyProfileSchema = z.discriminatedUnion("provider", [
	z
		.object({
			schemaVersion: z.literal(1),
			provider: z.literal("sightengine"),
			contractVersion: z.literal("sightengine-video-2026-10-04.1"),
			ruleVersion: z.literal("video-safety-2026-10-04.1"),
			policyVersion: z.literal("video-policy-2026-10-04.1"),
			sampling: z.object(coverage).strict(),
		})
		.strict(),
	z
		.object({
			schemaVersion: z.literal(1),
			provider: z.literal("seeapi"),
			completionMode: z.literal("callback-confirm-once"),
			contractVersion: z.literal("seeapi-video-nsfw-schema5-2026-10-04.1"),
			ruleVersion: z.literal("seeapi-video-safety-2026-10-04.1"),
			policyVersion: z.literal("seeapi-video-policy-2026-10-04.1"),
			sampling: z
				.object({
					...coverage,
					numFrames: z.number().int().min(8).max(32),
					thresholdOffset: z.literal(0),
					strictSpecialCare: z.literal(true),
					returnFrames: z.literal("none"),
				})
				.strict(),
		})
		.strict(),
]);
export type VideoVisualSafetyProfile = z.infer<typeof videoVisualSafetyProfileSchema>;

export function createVideoVisualSafetyProfile(
	provider: VideoVisualSafetyProfile["provider"],
	durationSeconds: number,
): VideoVisualSafetyProfile {
	if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 2 || durationSeconds > 30)
		throw new Error("VIDEO_SAFETY_PROFILE_INVALID");
	const sampling = {
		maxFirstFrameMillis: 250 as const,
		maxLastFrameGapMillis: 1000 as const,
		maxEndOverrunMillis: 500 as const,
		maxFrameGapMillis: 1000 as const,
	};
	if (provider === "sightengine")
		return {
			schemaVersion: 1,
			provider,
			contractVersion: "sightengine-video-2026-10-04.1",
			ruleVersion: "video-safety-2026-10-04.1",
			policyVersion: "video-policy-2026-10-04.1",
			sampling,
		};
	if (provider !== "seeapi") throw new Error("VIDEO_SAFETY_PROFILE_INVALID");
	return {
		schemaVersion: 1,
		provider,
		contractVersion: "seeapi-video-nsfw-schema5-2026-10-04.1",
		completionMode: "callback-confirm-once",
		ruleVersion: "seeapi-video-safety-2026-10-04.1",
		policyVersion: "seeapi-video-policy-2026-10-04.1",
		sampling: {
			...sampling,
			numFrames: Math.max(8, Math.min(32, durationSeconds + 2)),
			thresholdOffset: 0,
			strictSpecialCare: true,
			returnFrames: "none",
		},
	};
}

/** New admissions require an explicit server selection. No implicit provider fallback. */
export function configuredVideoVisualSafetyProfile(
	environment: Record<string, string | undefined>,
	durationSeconds: number,
): VideoVisualSafetyProfile {
	const provider = environment.VIDEO_V1_VIDEO_SAFETY_ADAPTER;
	if (provider !== "seeapi") throw new Error("VIDEO_MODERATION_NOT_CONFIGURED");
	return createVideoVisualSafetyProfile(provider, durationSeconds);
}

/** Only absent historical profiles resolve to the frozen legacy contract, never current env. */
export function readVideoVisualSafetyProfile(snapshot: unknown): VideoVisualSafetyProfile {
	const parsed = z
		.object({
			duration: z.number().int().min(2).max(30),
			visualSafetyProfile: z.unknown().optional(),
		})
		.safeParse(snapshot);
	if (!parsed.success) throw new Error("VIDEO_SAFETY_PROFILE_INVALID");
	if (parsed.data.visualSafetyProfile === undefined)
		return createVideoVisualSafetyProfile("sightengine", parsed.data.duration);
	const profile = videoVisualSafetyProfileSchema.safeParse(parsed.data.visualSafetyProfile);
	if (!profile.success) throw new Error("VIDEO_SAFETY_PROFILE_INVALID");
	if (
		profile.data.provider === "seeapi" &&
		profile.data.sampling.numFrames !== Math.max(8, Math.min(32, parsed.data.duration + 2))
	)
		throw new Error("VIDEO_SAFETY_PROFILE_INVALID");
	return profile.data;
}
