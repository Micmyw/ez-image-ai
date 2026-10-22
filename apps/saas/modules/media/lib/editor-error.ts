import { isPublicModerationReason, type PublicModerationReason } from "@repo/config/client";

export type EditorErrorKey =
	| "insufficientCredits"
	| "insufficientImagePasses"
	| "imagePassUnavailable"
	| "fundingChanged"
	| "qualityUnavailable"
	| "assetNotReady"
	| "referenceExpired"
	| "quoteExpired"
	| "priceChanged"
	| "contentNotAllowed"
	| "safetyUnavailable"
	| "contentReviewRequired"
	| "textLanguageUnsupported"
	| "concurrentLimit"
	| "providerBusy"
	| "rateLimited"
	| "inputTooLarge"
	| "safeError";

export function getEditorErrorKey(error: unknown): EditorErrorKey {
	const value =
		error && typeof error === "object"
			? (error as { code?: unknown; message?: unknown; data?: { code?: unknown } })
			: {};
	const codes = [value.code, value.data?.code, value.message];
	if (codes.includes("MEDIA_REQUEST_CONFLICT")) return "safeError";
	if (codes.includes("IMAGE_PASS_INSUFFICIENT")) return "insufficientImagePasses";
	if (codes.includes("GENERATION_FUNDING_CONFLICT")) return "fundingChanged";
	if (
		[
			"IMAGE_PASS_SELECTION_INVALID",
			"IMAGE_PASS_OUTPUT_COUNT_INVALID",
			"IMAGE_PASS_UNAVAILABLE",
		].some((code) => codes.includes(code))
	)
		return "imagePassUnavailable";
	if (codes.includes("PROVIDER_CONCURRENT_JOB_LIMIT_REACHED")) return "providerBusy";
	if (codes.includes("CONCURRENT_JOB_LIMIT_REACHED")) return "concurrentLimit";
	if (codes.includes("RATE_LIMITED") || codes.includes("TOO_MANY_REQUESTS")) return "rateLimited";
	const message = error instanceof Error ? error.message : "";
	if (message.includes("INSUFFICIENT_CREDITS")) return "insufficientCredits";
	if (message.includes("ENTITLEMENT_REQUIRED")) return "qualityUnavailable";
	if (message.includes("ASSET_NOT_READY")) return "assetNotReady";
	if (message.includes("TEMPORARY_REFERENCE_")) return "referenceExpired";
	if (message.includes("PRICE_CHANGED")) return "priceChanged";
	if (message.includes("QUOTE_EXPIRED")) {
		return "quoteExpired";
	}
	if (message.includes("CONTENT_NOT_ALLOWED")) return "contentNotAllowed";
	if (message.includes("CONTENT_REVIEW_REQUIRED")) return "contentReviewRequired";
	if (message.includes("TEXT_LANGUAGE_UNSUPPORTED")) return "textLanguageUnsupported";
	if (message.includes("SAFETY_CHECK_UNAVAILABLE")) return "safetyUnavailable";
	if (message.includes("INPUT_TOO_LARGE")) return "inputTooLarge";
	return "safeError";
}

export function getPromptSafetyOutcome(
	error: unknown,
): "blocked" | "review" | "unsupportedLanguage" | "unavailable" | null {
	switch (getEditorErrorKey(error)) {
		case "contentNotAllowed":
			return "blocked";
		case "contentReviewRequired":
			return "review";
		case "textLanguageUnsupported":
			return "unsupportedLanguage";
		case "safetyUnavailable":
			return "unavailable";
		default:
			return null;
	}
}

export function getModerationErrorReason(error: unknown): PublicModerationReason | null {
	if (!(error instanceof Error) || !error.message.includes("CONTENT_NOT_ALLOWED")) return null;
	const data = "data" in error ? error.data : undefined;
	if (!data || typeof data !== "object" || !("moderationReason" in data)) return null;
	return isPublicModerationReason(data.moderationReason) ? data.moderationReason : null;
}
