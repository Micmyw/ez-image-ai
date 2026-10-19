import { describe, expect, it } from "vitest";

import { getEditorErrorKey, getModerationErrorReason } from "./editor-error";

describe("getEditorErrorKey", () => {
	it.each([
		["INSUFFICIENT_CREDITS", "insufficientCredits"],
		["IMAGE_PASS_INSUFFICIENT", "insufficientImagePasses"],
		["IMAGE_PASS_SELECTION_INVALID", "imagePassUnavailable"],
		["IMAGE_PASS_OUTPUT_COUNT_INVALID", "imagePassUnavailable"],
		["IMAGE_PASS_UNAVAILABLE", "imagePassUnavailable"],
		["GENERATION_FUNDING_CONFLICT", "fundingChanged"],
		["ENTITLEMENT_REQUIRED", "qualityUnavailable"],
		["ASSET_NOT_READY", "assetNotReady"],
		["QUOTE_EXPIRED", "quoteExpired"],
		["PRICE_CHANGED", "priceChanged"],
		["CONTENT_REVIEW_REQUIRED", "contentReviewRequired"],
		["TEXT_LANGUAGE_UNSUPPORTED", "textLanguageUnsupported"],
		["CONTENT_NOT_ALLOWED", "contentNotAllowed"],
		["CONCURRENT_JOB_LIMIT_REACHED", "concurrentLimit"],
		["PROVIDER_CONCURRENT_JOB_LIMIT_REACHED", "providerBusy"],
		["RATE_LIMITED", "rateLimited"],
		["INPUT_TOO_LARGE", "inputTooLarge"],
	] as const)("maps %s to safe editor copy", (code, key) => {
		expect(getEditorErrorKey(new Error(code))).toBe(key);
	});
	it.each([
		["CONCURRENT_JOB_LIMIT_REACHED", "concurrentLimit"],
		["PROVIDER_CONCURRENT_JOB_LIMIT_REACHED", "providerBusy"],
		["RATE_LIMITED", "rateLimited"],
	] as const)(
		"reads the structured public code %s without relying on the transport message",
		(code, key) => {
			expect(
				getEditorErrorKey({ code: "BAD_REQUEST", message: "Request rejected", data: { code } }),
			).toBe(key);
		},
	);

	it.each([
		"UNKNOWN_CONCURRENT_JOB_LIMIT_REACHED",
		"PROVIDER_CONCURRENT_JOB_LIMIT_REACHED_UNKNOWN",
	])("does not attribute unknown capacity %s to the account", (code) =>
		expect(getEditorErrorKey(new Error(code))).toBe("safeError"),
	);

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
