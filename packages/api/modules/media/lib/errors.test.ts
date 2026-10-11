import { describe, expect, it } from "vitest";

import { stableMediaErrorCode, toMediaOrpcError } from "./errors";

describe("public media capacity errors", () => {
	it.each([
		["ASSET_CONTENT_NOT_ALLOWED", "CONTENT_NOT_ALLOWED"],
		["GUEST_PRICE_CHANGED", "PRICE_CHANGED"],
		["JOB_NOT_FOUND", "NOT_FOUND"],
	] as const)("preserves the existing non-capacity alias %s", (message, expected) => {
		expect(stableMediaErrorCode(new Error(message))).toBe(expected);
	});
	it.each([
		"CONCURRENT_JOB_LIMIT_REACHED",
		"PROVIDER_CONCURRENT_JOB_LIMIT_REACHED",
		"RATE_LIMITED",
	] as const)("preserves the admission scope of %s in the public response", (code) => {
		const error = new Error(code);
		expect(stableMediaErrorCode(error)).toBe(code);
		expect(toMediaOrpcError(error)).toMatchObject({
			code: "BAD_REQUEST",
			message: code,
			data: { code },
		});
	});

	it.each([
		"UNKNOWN_CONCURRENT_JOB_LIMIT_REACHED",
		"PROVIDER_CONCURRENT_JOB_LIMIT_REACHED_UNKNOWN",
		"UNKNOWN_RATE_LIMITED",
		"Bearer private-provider-payload",
	])("does not mistake the unknown error %s for a public admission rejection", (message) => {
		expect(stableMediaErrorCode(new Error(message))).toBe("PROVIDER_UNAVAILABLE");
	});
});
