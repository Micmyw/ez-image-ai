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

/** A business permission, explicitly distinct from a positive classifier verdict. */
export const MODERATION_BYPASS_REASON = "MODERATION_TECHNICAL_FAILURE_BYPASS";
export const MODERATION_MAX_FAILURES = 4;
export function isPermittedModerationEvidence<T extends { status: string; reasonCode?: string }>(
	evidence: T | undefined | null,
): evidence is T {
	return (
		evidence?.status === "APPROVED" ||
		(evidence?.status === "BYPASSED" && evidence.reasonCode === MODERATION_BYPASS_REASON)
	);
}
export const MODERATION_RETRYABLE_ERROR_CODES = [
	"MODERATION_UNAVAILABLE",
	"MODERATION_TIMEOUT",
	"MODERATION_NETWORK_ERROR",
	"MODERATION_RATE_LIMITED",
	"MODERATION_INVALID_RESPONSE",
	"MODERATION_SERVICE_ERROR",
	"MODERATION_SUBMISSION_UNCERTAIN",
] as const;
export function isRetryableModerationError(code: string): boolean {
	return MODERATION_RETRYABLE_ERROR_CODES.some((candidate) => candidate === code);
}
export function moderationHttpErrorCode(status: number): string {
	if (status === 401 || status === 403) return "MODERATION_CONFIGURATION_ERROR";
	if (status === 400 || status === 422) return "MODERATION_INVALID_INPUT";
	if (status === 429) return "MODERATION_RATE_LIMITED";
	if (status === 408 || status === 504) return "MODERATION_TIMEOUT";
	return status >= 500 ? "MODERATION_SERVICE_ERROR" : "MODERATION_INVALID_RESPONSE";
}
export function moderationServiceErrorCode(error: unknown): string {
	if (!error || typeof error !== "object") return "MODERATION_UNAVAILABLE";
	const value = error as {
		message?: unknown;
		name?: unknown;
		code?: unknown;
		originalCause?: unknown;
	};
	if (
		typeof value.message === "string" &&
		(isRetryableModerationError(value.message) ||
			["MODERATION_CONFIGURATION_ERROR", "MODERATION_INVALID_INPUT"].includes(value.message))
	)
		return value.message;
	if (value.name === "AbortError" || value.name === "TimeoutError") return "MODERATION_TIMEOUT";
	if (value.originalCause && value.originalCause !== error) {
		const cause = value.originalCause as { name?: unknown };
		if (cause.name === "AbortError" || cause.name === "TimeoutError") return "MODERATION_TIMEOUT";
		if (cause.name === "TypeError") return "MODERATION_NETWORK_ERROR";
	}
	if (value.name === "ZodError" || value.code === "MALFORMED_PROVIDER_RESPONSE")
		return "MODERATION_INVALID_RESPONSE";
	if (value.name === "TypeError") return "MODERATION_NETWORK_ERROR";
	return "MODERATION_UNAVAILABLE";
}

export function isPublicModerationReason(value: unknown): value is PublicModerationReason {
	return typeof value === "string" && PUBLIC_MODERATION_REASONS.some((reason) => reason === value);
}
