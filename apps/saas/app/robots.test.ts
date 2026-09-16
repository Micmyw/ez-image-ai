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
			sitemap: ["/sitemap.xml", "/sitemap-images.xml"].map(
				(path) => new URL(path, getBaseUrl()).href,
			),
		});
	});

	it("keeps rendered scripts, styles and public artwork crawlable", () => {
		const rules = robots().rules;
		if (Array.isArray(rules)) throw new Error("Expected a single public crawler rule");
		const blocked = [rules.disallow].flat();
		for (const path of [
			"/_next/static/chunks/app.js",
			"/images/models/example.webp",
			"/examples/case.webp",
		]) {
			expect(
				blocked.some((prefix) => prefix && path.startsWith(prefix)),
				path,
			).toBe(false);
		}
	});
});
