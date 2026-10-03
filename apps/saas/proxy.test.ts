import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as effects from "./modules/effects/lib/content";
import { proxy } from "./proxy";
afterEach(() => vi.restoreAllMocks());

describe("public content proxy", () => {
	it("keeps editorial previews out of indexing", () => {
		const response = proxy(new NextRequest("https://example.com/effects-preview/1980s-ai-photo"));
		expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		expect(response.headers.get("x-middleware-request-x-next-intl-locale")).toBe("en");
	});
	it("leaves legacy recipe redirects to the Blog publication gate instead of following an independent retirement mapping", () => {
		const retired = vi.spyOn(effects, "getRetiredEffectBySlug").mockReturnValue({
			id: "old",
			slug: "old",
			status: "retired",
			retirement: { reason: "Merged", retiredAt: "2026-09-29", replacementEffectId: "draft" },
			redirectTo: "/blog/draft",
		});
		const response = proxy(new NextRequest("https://example.com/effects/old?preset=obsolete"));
		expect(response.headers.get("x-middleware-next")).toBe("1");
		expect(response.headers.get("location")).toBeNull();
		expect(retired).not.toHaveBeenCalled();
	});
	it("keeps an explicit translated Blog view noindex", () => {
		const response = proxy(new NextRequest("https://example.com/blog/1980s-ai-photo?lang=de"));
		expect(response.headers.get("x-robots-tag")).toBe("noindex, follow");
		expect(response.headers.get("x-middleware-request-x-next-intl-locale")).toBe("de");
	});
	it.each(["/", "/?lang=invalid", "/?lang=en"])(
		"keeps %s in English despite the account cookie",
		(path) => {
			const response = proxy(
				new NextRequest(`https://example.com${path}`, { headers: { cookie: "NEXT_LOCALE=fr" } }),
			);
			expect(response.headers.get("x-middleware-request-x-next-intl-locale")).toBe("en");
			expect(response.headers.get("x-robots-tag")).toBeNull();
		},
	);
});
