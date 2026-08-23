import { describe, expect, it } from "vitest";

import { getSafeRedirectPath } from "./redirect";

describe("getSafeRedirectPath", () => {
	it.each([
		["/", "/"],
		["/dashboard", "/dashboard"],
		["/settings/billing?interval=year#plans", "/settings/billing?interval=year#plans"],
		["/organizations/../settings", "/settings"],
	])("allows the internal path %s", (path, expected) => {
		expect(getSafeRedirectPath(path, "/fallback")).toBe(expected);
	});

	it.each([
		"https://attacker.example",
		"https://saas.invalid/settings",
		"//attacker.example",
		"///attacker.example",
		"/\\attacker.example",
		"javascript:alert(1)",
		"data:text/html,malicious",
		"dashboard",
		"/%2e%2e//attacker.example",
	])("rejects the unsafe redirect %s", (path) => {
		expect(getSafeRedirectPath(path, "/fallback")).toBe("/fallback");
	});

	it("uses the fallback when no redirect is provided", () => {
		expect(getSafeRedirectPath(null, "/fallback")).toBe("/fallback");
	});

	it("falls back to the app root when the fallback is also unsafe", () => {
		expect(getSafeRedirectPath("https://attacker.example", "//attacker.example")).toBe("/");
	});
});
