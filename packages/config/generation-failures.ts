export type TechnicalGenerationFailureCode =
	| "GENERATION_TIMEOUT"
	| "GENERATION_SERVICE_UNAVAILABLE";

export function isTechnicalGenerationFailureCode(
	code: unknown,
): code is TechnicalGenerationFailureCode {
	return code === "GENERATION_TIMEOUT" || code === "GENERATION_SERVICE_UNAVAILABLE";
}

/** Customer-facing failure classes. Content refusals keep their own moderation path. */
export type GenerationFailureCategory = "input" | "provider" | "timeout" | "transfer" | "unknown";

/**
 * Specific internal failure codes that settlement keeps on the job instead of
 * collapsing them into NO_USABLE_OUTPUT. Input/content rejections stay collapsed
 * because moderation evidence, not the code, explains them.
 */
const PRESERVED_FAILURE_CATEGORIES = {
	GENERATION_TIMEOUT: "timeout",
	GENERATION_SERVICE_UNAVAILABLE: "provider",
	PROVIDER_UNAVAILABLE: "provider",
	PROVIDER_ADAPTER_UNAVAILABLE: "provider",
	PROVIDER_RECOVERY_UNAVAILABLE: "provider",
	PROVIDER_SUBMISSION_TASK_MISMATCH: "provider",
	RECONCILIATION_TERMINAL_UNVERIFIED: "provider",
	QUOTED_ROUTE_UNAVAILABLE: "provider",
	LEGACY_QUOTE_ROUTE_UNAVAILABLE: "provider",
	QUOTED_INPUT_UNSUPPORTED: "input",
	TEMPORARY_REFERENCE_EXPIRED: "input",
	ASSET_VERIFICATION_FAILED: "input",
	ASSET_VERIFICATION_DEADLINE_EXCEEDED: "input",
	ASSET_VERIFICATION_SUBMISSION_UNCERTAIN: "input",
	INPUT_REVERIFICATION_FAILED: "input",
	INPUT_REVERIFICATION_DEADLINE_EXCEEDED: "input",
	OUTPUT_TRANSFER_FENCE_LOST: "transfer",
	OUTPUT_TRANSFER_FAILURE_PERSIST_RETRYABLE: "transfer",
	OUTPUT_MEDIA_SIZE_EXCEEDED: "transfer",
	OUTPUT_MEDIA_TYPE_UNSUPPORTED: "transfer",
	STREAMING_OUTPUT_WRITE_UNAVAILABLE: "transfer",
} as const satisfies Record<string, GenerationFailureCategory>;

export type PreservedGenerationFailureCode = keyof typeof PRESERVED_FAILURE_CATEGORIES;

export function isPreservedGenerationFailureCode(
	code: unknown,
): code is PreservedGenerationFailureCode {
	return typeof code === "string" && Object.hasOwn(PRESERVED_FAILURE_CATEGORIES, code);
}

export function generationFailureCategory(code: unknown): GenerationFailureCategory {
	return isPreservedGenerationFailureCode(code) ? PRESERVED_FAILURE_CATEGORIES[code] : "unknown";
}
