import { describe, expect, it } from "vitest";

import {
	BLOG_AD_SANDBOX,
	BLOG_AD_PREVIEW_EXPIRES_AT,
	BLOG_AD_PREVIEW_PATH,
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

	it("uses only the independent static document URL, without article data or query", () => {
		for (const format of ["banner", "native"] as const) {
			const url = getBlogAdDocumentUrl(format);
			expect(url).toBe(`https://ads.ezimageai.com/${format}.html`);
		}
	});

	it("limits an explicit preview to one article, one requested format and the finite window", () => {
		const now = Date.parse(BLOG_AD_PREVIEW_EXPIRES_AT) - 1;
		expect(
			getBlogAdSettings({}, { pathname: BLOG_AD_PREVIEW_PATH, format: "banner", now }),
		).toEqual({
			enabled: true,
			nativeEnabled: false,
			bannerEnabled: true,
			testExpiresAt: BLOG_AD_PREVIEW_EXPIRES_AT,
		});
		expect(
			getBlogAdSettings({}, { pathname: BLOG_AD_PREVIEW_PATH, format: "native", now })
				.nativeEnabled,
		).toBe(true);
		expect(
			getBlogAdSettings({}, { pathname: BLOG_AD_PREVIEW_PATH, format: "native", now })
				.bannerEnabled,
		).toBe(false);
		for (const pathname of [
			"/",
			"/create",
			"/blog",
			"/blog/raindance-ai-trend",
			"/blog/ai-image-editing-prompts",
		]) {
			expect(getBlogAdSettings({}, { pathname, format: "native", now }).enabled).toBe(false);
		}
		for (const format of [undefined, "1", "all", ["banner", "native"]]) {
			expect(getBlogAdSettings({}, { pathname: BLOG_AD_PREVIEW_PATH, format, now }).enabled).toBe(
				false,
			);
		}
		expect(
			getBlogAdSettings({}, { pathname: BLOG_AD_PREVIEW_PATH, format: "banner", now: now + 1 })
				.enabled,
		).toBe(false);
	});
});
