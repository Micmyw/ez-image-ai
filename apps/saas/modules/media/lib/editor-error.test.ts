import { describe, expect, it } from "vitest";

import { getEditorErrorKey } from "./editor-error";

describe("getEditorErrorKey", () => {
	it.each([
		["INSUFFICIENT_CREDITS", "insufficientCredits"],
		["ENTITLEMENT_REQUIRED", "qualityUnavailable"],
		["ASSET_NOT_READY", "assetNotReady"],
		["QUOTE_EXPIRED", "quoteExpired"],
		["PRICE_CHANGED", "quoteExpired"],
		["CONTENT_NOT_ALLOWED", "contentNotAllowed"],
	] as const)("maps %s to safe editor copy", (code, key) => {
		expect(getEditorErrorKey(new Error(code))).toBe(key);
	});

	it("never renders an unknown provider error", () => {
		expect(getEditorErrorKey(new Error("provider-secret raw response"))).toBe("safeError");
	});
});
