import { describe, expect, it } from "vitest";

import { resolveRequestLocale } from "./locale";

describe("request locale resolution", () => {
	it("accepts configured request and cookie locales", () => {
		expect(resolveRequestLocale("fr", "de")).toBe("fr");
		expect(resolveRequestLocale(undefined, "de")).toBe("de");
	});

	it("falls back instead of importing an attacker-controlled locale", () => {
		expect(resolveRequestLocale("../../private", "es")).toBe("es");
		expect(resolveRequestLocale(undefined, "not-a-locale")).toBe("en");
		expect(resolveRequestLocale(null, null)).toBe("en");
	});
});
