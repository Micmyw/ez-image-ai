import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "./proxy";

describe("explicit public language selection", () => {
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
