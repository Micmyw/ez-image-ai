export type TechnicalGenerationFailureCode =
	| "GENERATION_TIMEOUT"
	| "GENERATION_SERVICE_UNAVAILABLE";

export function isTechnicalGenerationFailureCode(
	code: unknown,
): code is TechnicalGenerationFailureCode {
	return code === "GENERATION_TIMEOUT" || code === "GENERATION_SERVICE_UNAVAILABLE";
}
