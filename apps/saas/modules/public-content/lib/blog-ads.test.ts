import { describe, expect, it } from "vitest";

import {
	BLOG_AD_SANDBOX,
	getBlogAdDocument,
	getBlogAdDocumentUrl,
	getBlogAdSettings,
} from "./blog-ads";

describe("blog ad frame contract", () => {
	it("defaults off, with native inventory separately gated", () => {
		expect(getBlogAdSettings({})).toEqual({ enabled: false, nativeEnabled: false });
		expect(getBlogAdSettings({ BLOG_ADS_ENABLED: "1", BLOG_NATIVE_ADS_ENABLED: "true" })).toEqual({
			enabled: false,
			nativeEnabled: false,
		});
		expect(getBlogAdSettings({ BLOG_ADS_ENABLED: "true" })).toEqual({
			enabled: true,
			nativeEnabled: false,
		});
	});

	it("limits host data access, top navigation, downloads and popups", () => {
		expect(BLOG_AD_SANDBOX.split(" ")).toEqual(["allow-scripts"]);
		for (const format of ["banner", "native"] as const) {
			const html = getBlogAdDocument(format);
			expect(html).toContain('<meta name="referrer" content="no-referrer">');
			expect(html).toContain('referrerpolicy="no-referrer"');
			expect(html).toContain("form-action 'none'");
			expect(html).not.toMatch(/userId|prompt|photo|signedUrl|ezimageai\.com/);
		}
	});

	it("preserves the supplied placement keys and banner size without inventing mobile parameters", () => {
		const html = getBlogAdDocument("banner");
		expect(html).toContain("'height':90,'width':728,'params':{}");
		expect(html).toContain("2266a6811e407f9b362831f885d09d1e/invoke.js");
		expect(getBlogAdDocument("native")).toContain(
			'id="container-0a9986f36ff843c117e0f20e732a1e08"',
		);
	});

	it("uses only the static document as its URL, without inheriting the article base URL", () => {
		for (const format of ["banner", "native"] as const) {
			const url = getBlogAdDocumentUrl(format);
			expect(url).toMatch(/^data:text\/html;charset=utf-8,/);
			expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(getBlogAdDocument(format));
		}
	});
});
