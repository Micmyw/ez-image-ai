import { isPublicModerationReason, type PublicModerationReason } from "@repo/config/client";

export type EditorErrorKey =
	| "insufficientCredits"
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
	| "inputTooLarge"
	| "safeError";

export function getEditorErrorKey(error: unknown): EditorErrorKey {
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
	if (message.includes("CONCURRENT_JOB_LIMIT_REACHED")) return "concurrentLimit";
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
