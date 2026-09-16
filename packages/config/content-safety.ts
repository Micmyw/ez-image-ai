/** Customer-facing categories only. Detector labels and diagnostics stay server-side. */
export const PUBLIC_MODERATION_REASONS = [
	"sexualContent",
	"minorSafety",
	"sexualExploitation",
	"identityMisuse",
	"violence",
	"selfHarm",
	"hate",
	"restrictedContent",
] as const;

export type PublicModerationReason = (typeof PUBLIC_MODERATION_REASONS)[number];

export function isPublicModerationReason(value: unknown): value is PublicModerationReason {
	return typeof value === "string" && PUBLIC_MODERATION_REASONS.some((reason) => reason === value);
}
