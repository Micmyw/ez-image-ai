import { describe, expect, it } from "vitest";

import { getEditorErrorKey, getModerationErrorReason } from "./editor-error";

describe("getEditorErrorKey", () => {
	it.each([
		["INSUFFICIENT_CREDITS", "insufficientCredits"],
		["ENTITLEMENT_REQUIRED", "qualityUnavailable"],
		["ASSET_NOT_READY", "assetNotReady"],
		["QUOTE_EXPIRED", "quoteExpired"],
		["PRICE_CHANGED", "priceChanged"],
		["CONTENT_REVIEW_REQUIRED", "contentReviewRequired"],
		["TEXT_LANGUAGE_UNSUPPORTED", "textLanguageUnsupported"],
		["CONTENT_NOT_ALLOWED", "contentNotAllowed"],
		["CONCURRENT_JOB_LIMIT_REACHED", "concurrentLimit"],
		["INPUT_TOO_LARGE", "inputTooLarge"],
	] as const)("maps %s to safe editor copy", (code, key) => {
		expect(getEditorErrorKey(new Error(code))).toBe(key);
	});

	it("never renders an unknown provider error", () => {
		expect(getEditorErrorKey(new Error("provider-secret raw response"))).toBe("safeError");
	});
	it.each([
		["CONTENT_NOT_ALLOWED", "sexualContent", "sexualContent"],
		["ASSET_CONTENT_NOT_ALLOWED", "restrictedContent", "restrictedContent"],
		["SAFETY_CHECK_UNAVAILABLE", "sexualContent", null],
		["NOT_FOUND", "sexualContent", null],
		["CONTENT_NOT_ALLOWED", "raw-private-label", null],
	])("only reads an allowlisted reason from %s", (code, reason, expected) => {
		expect(
			getModerationErrorReason(
				Object.assign(new Error(code), { data: { moderationReason: reason } }),
			),
		).toBe(expected);
	});
});
