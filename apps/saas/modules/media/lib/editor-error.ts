export type EditorErrorKey =
	| "insufficientCredits"
	| "qualityUnavailable"
	| "assetNotReady"
	| "quoteExpired"
	| "contentNotAllowed"
	| "concurrentLimit"
	| "inputTooLarge"
	| "safeError";

export function getEditorErrorKey(error: unknown): EditorErrorKey {
	const message = error instanceof Error ? error.message : "";
	if (message.includes("INSUFFICIENT_CREDITS")) return "insufficientCredits";
	if (message.includes("ENTITLEMENT_REQUIRED")) return "qualityUnavailable";
	if (message.includes("ASSET_NOT_READY")) return "assetNotReady";
	if (message.includes("QUOTE_EXPIRED") || message.includes("PRICE_CHANGED")) {
		return "quoteExpired";
	}
	if (message.includes("CONTENT_NOT_ALLOWED")) return "contentNotAllowed";
	if (message.includes("CONCURRENT_JOB_LIMIT_REACHED")) return "concurrentLimit";
	if (message.includes("INPUT_TOO_LARGE")) return "inputTooLarge";
	return "safeError";
}
