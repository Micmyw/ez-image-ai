import { getBaseUrl } from "@shared/lib/base-url";
import { describe, expect, it } from "vitest";

import robots from "./robots";

describe("SaaS robots", () => {
	it("indexes the landing page while keeping product and API routes private", () => {
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
					"/login",
					"/settings/",
					"/signup",
					"/try",
				],
			},
			sitemap: new URL("/sitemap.xml", getBaseUrl()).href,
		});
	});
});
