import { getBaseUrl } from "@shared/lib/base-url";
import { describe, expect, it } from "vitest";

import robots from "./robots";

describe("SaaS robots", () => {
	it("allows reading public and login noindex tags while limiting product and API crawling", () => {
		expect(robots()).toEqual({
			rules: {
				userAgent: "*",
				allow: "/",
				disallow: [
					"/api/",
					"/admin/",
					"/assets",
					"/create",
					"/draft/",
					"/edits",
					"/history",
					"/settings/",
					"/try",
				],
			},
			sitemap: new URL("/sitemap.xml", getBaseUrl()).href,
		});
	});
});
