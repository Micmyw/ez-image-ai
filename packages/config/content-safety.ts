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

/** Historical audit identifier. Technical failure is never approval. */
export const MODERATION_BYPASS_REASON = "MODERATION_TECHNICAL_FAILURE_BYPASS";
export const MODERATION_MAX_FAILURES = 4;
/** Input-only permission; never a detector approval or permission to serve an output. */
export const SEEAPI_INPUT_DELEGATION_REASON = "SEEAPI_INPUT_TECHNICAL_FAILURE_DELEGATED_V1";
export const SEEAPI_INPUT_DELEGATION_CODES = [
	"RATE_LIMITED",
	"DETECTION_REPORT_FAILED",
	"PROVIDER_TIMEOUT",
] as const;

export function isDelegatedImageInputEvidence(
	evidence:
		| {
				status: string;
				reasonCode?: string | null;
				provider?: string;
				evidenceKind?: string | null;
				providerTaskId?: string | null;
		  }
		| null
		| undefined,
	asset: {
		kind: string;
		mimeType: string;
		ownerType?: string;
		retentionClass?: string;
		verificationEngine?: string;
	},
): boolean {
	return (
		evidence?.status === "BYPASSED" &&
		evidence.reasonCode === SEEAPI_INPUT_DELEGATION_REASON &&
		evidence.provider === "seeapi" &&
		evidence.evidenceKind === "INPUT" &&
		Boolean(evidence.providerTaskId) &&
		asset.kind === "INPUT" &&
		asset.ownerType === "USER" &&
		asset.retentionClass === "ACCOUNT" &&
		asset.verificationEngine === "legacy" &&
		["image/jpeg", "image/png", "image/webp"].includes(asset.mimeType)
	);
}
export function isPermittedModerationEvidence<T extends { status: string; reasonCode?: string }>(
	evidence: T | undefined | null,
): evidence is T {
	return evidence?.status === "APPROVED";
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
			[
				"MODERATION_CONFIGURATION_ERROR",
				"MODERATION_INVALID_INPUT",
				"MODERATION_MEDIA_INVALID",
			].includes(value.message))
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
