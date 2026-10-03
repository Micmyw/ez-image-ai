import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as effects from "./modules/effects/lib/content";
import { proxy } from "./proxy";

describe("explicit public language selection", () => {
	afterEach(() => vi.restoreAllMocks());
	it("keeps protected previews noindex and English", () => {
		const response = proxy(new NextRequest("https://example.com/effects-preview/1980s-ai-photo"));
		expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		expect(response.headers.get("x-middleware-request-x-next-intl-locale")).toBe("en");
	});
	it("returns an actual 410 for a retired effect without a replacement", () => {
		vi.spyOn(effects, "getRetiredEffectBySlug").mockReturnValue({
			id: "old",
			slug: "old",
			status: "retired",
			retirement: { reason: "Retired", retiredAt: "2026-09-29" },
		});
		const response = proxy(new NextRequest("https://example.com/effects/old"));
		expect(response.status).toBe(410);
		expect(response.headers.get("x-robots-tag")).toBe("noindex, follow");
	});
	it("permanently redirects an equivalent retirement without forwarding arbitrary queries", () => {
		vi.spyOn(effects, "getRetiredEffectBySlug").mockReturnValue({
			id: "old",
			slug: "old",
			status: "retired",
			retirement: { reason: "Merged", retiredAt: "2026-09-29", replacementEffectId: "replacement" },
			redirectTo: "/effects/replacement",
		});
		const response = proxy(new NextRequest("https://example.com/effects/old?preset=obsolete"));
		expect(response.status).toBe(308);
		expect(response.headers.get("location")).toBe("https://example.com/effects/replacement");
	});
	it("renders the selected language without indexing a duplicate of the English URL", () => {
		const response = proxy(new NextRequest("https://example.com/?lang=de"));
		expect(response.headers.get("x-middleware-request-x-next-intl-locale")).toBe("de");
		expect(response.headers.get("x-robots-tag")).toBe("noindex, follow");
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
