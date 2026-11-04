import { describe, expect, it } from "vitest";

import {
	generationFailureCategory,
	isPreservedGenerationFailureCode,
	isTechnicalGenerationFailureCode,
} from "./generation-failures";

describe("generation failure classification", () => {
	it.each([
		["GENERATION_TIMEOUT", "timeout"],
		["GENERATION_SERVICE_UNAVAILABLE", "provider"],
		["PROVIDER_UNAVAILABLE", "provider"],
		["RECONCILIATION_TERMINAL_UNVERIFIED", "provider"],
		["TEMPORARY_REFERENCE_EXPIRED", "input"],
		["ASSET_VERIFICATION_FAILED", "input"],
		["INPUT_REVERIFICATION_DEADLINE_EXCEEDED", "input"],
		["OUTPUT_TRANSFER_FENCE_LOST", "transfer"],
		["OUTPUT_MEDIA_SIZE_EXCEEDED", "transfer"],
	])("keeps %s as %s", (code, category) => {
		expect(isPreservedGenerationFailureCode(code)).toBe(true);
		expect(generationFailureCategory(code)).toBe(category);
	});
	it.each([
		"NO_USABLE_OUTPUT",
		"INPUT_REVERIFICATION_REJECTED",
		"INPUT_REVERIFICATION_REVIEW_REQUIRED",
		"OUTPUT_CONTENT_BLOCKED_CHARGED",
		"toString",
		"__proto__",
		null,
		undefined,
		42,
	])("leaves %s unclassified so content and unknown failures stay generic", (code) => {
		expect(isPreservedGenerationFailureCode(code)).toBe(false);
		expect(generationFailureCategory(code)).toBe("unknown");
	});
	it("keeps the technical-code contract used by the public failure reason", () => {
		expect(isTechnicalGenerationFailureCode("GENERATION_TIMEOUT")).toBe(true);
		expect(isTechnicalGenerationFailureCode("PROVIDER_UNAVAILABLE")).toBe(false);
	});
});
