import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { config as proxyConfig, proxy } from "../../../proxy";
import { PUBLIC_PAGE_LANGUAGES, publicPagePath } from "./indexing";
import { createPublicPageMetadata } from "./metadata";

vi.mock("@shared/lib/base-url", () => ({ getBaseUrl: () => "https://example.com" }));

function inspect(path: string, query = "") {
	const searchParams = Object.fromEntries(new URLSearchParams(query));
	return {
		metadata: createPublicPageMetadata({
			path,
			title: "Public page",
			description: "Factual content",
			index: true,
			searchParams,
		}),
		header: proxy(
			new NextRequest(`https://example.com${path}${query ? `?${query}` : ""}`),
		).headers.get("x-robots-tag"),
	};
}

describe("public HTML and HTTP indexing agree", () => {
	it("keeps imported template discovery unindexed until target acceptance is reviewed", () => {
		expect(proxyConfig.matcher).toContain("/video-templates/:path*");
		for (const path of ["/video-templates", "/video-templates/bulin-47"]) {
			const { metadata, header } = inspect(path);
			expect(metadata.robots).toEqual({ index: false, follow: true });
			expect(header).toBe("noindex, follow");
			const privateView = inspect(path, "asset=owned-photo");
			expect(privateView.metadata.robots).toEqual({ index: false, follow: false });
			expect(privateView.header).toBe("noindex, nofollow");
		}
	});
	it.each(["en", "de", "es", "fr"])(
		"keeps the public purchase page private to crawlers while setting its %s URL locale",
		(locale) => {
			expect(proxyConfig.matcher).toContain("/image-pass");
			const response = proxy(
				new NextRequest(`https://example.com/image-pass?lang=${locale}&intentId=private`, {
					headers: { cookie: "NEXT_LOCALE=de" },
				}),
			);
			expect(response.headers.get("x-middleware-request-x-next-intl-locale")).toBe(locale);
			expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		},
	);
	it.each(
		Object.entries(PUBLIC_PAGE_LANGUAGES)
			.filter(([path]) => !path.startsWith("/video-templates"))
			.flatMap(([path, languages]) => languages.map((locale) => [path, locale])),
	)("indexes real translated content at %s in %s with reciprocal alternatives", (path, locale) => {
		const { metadata, header } = inspect(path!, `lang=${locale}`);
		expect(metadata.robots).toEqual({ index: true, follow: true });
		expect(header).toBeNull();
		expect(metadata.alternates?.canonical).toBe(
			`https://example.com${publicPagePath(path!, locale!)}`,
		);
		expect(metadata.alternates?.languages).toMatchObject({
			en: `https://example.com${path}`,
			"x-default": `https://example.com${path}`,
		});
	});
	it.each([
		"/docs/video-beta",
		"/blog/raindance-ai-trend",
		"/models",
		"/models/gpt-image-2",
		"/changelog",
		"/terms",
		"/photo-to-coloring-page",
		"/gpt-image-2-6",
		"/minimax-h3-image",
		"/ai-svg-generator",
		"/ai-gif-generator",
		"/video-effects/hotel-lobby-ai",
		"/privacy",
	])("keeps untranslated main content at %s canonical to English", (path) => {
		const { metadata, header } = inspect(path, "lang=fr");
		expect(metadata.robots).toEqual({ index: false, follow: true });
		expect(header).toBe("noindex, follow");
		expect(metadata.alternates?.canonical).toBe(`https://example.com${path}`);
	});
	it.each([
		"asset",
		"guestAsset",
		"guestJob",
		"job",
		"videoJob",
		"reuseJob",
		"parentJob",
		"resume",
		"draftError",
		"upgrade",
		"returnTo",
	])("excludes personal %s state even when its value is empty", (key) => {
		for (const path of [
			"/",
			"/create",
			"/image-to-image",
			"/photo-to-coloring-page",
			"/gpt-image-2-6",
			"/minimax-h3-image",
			"/ai-svg-generator",
			"/ai-gif-generator",
			"/video-effects/hotel-lobby-ai",
			"/blog/1980s-ai-photo",
		]) {
			const { metadata, header } = inspect(path, `${key}=&lang=de`);
			expect(metadata.robots, path).toEqual({ index: false, follow: false });
			expect(header, path).toBe("noindex, nofollow");
			expect(JSON.stringify(metadata.alternates?.canonical)).not.toContain(`${key}=`);
		}
	});
	it("keeps public generator mode and tracking parameters crawlable, with a clean canonical", () => {
		const { metadata, header } = inspect(
			"/create",
			"mode=video&source=navigation&utm_source=campaign",
		);
		expect(metadata.robots).toEqual({ index: true, follow: true });
		expect(header).toBeNull();
		expect(metadata.alternates?.canonical).toBe("https://example.com/create");
	});
	it.each([
		["/blog", "q=photo"],
		["/blog", "category=editing"],
		["/blog/raindance-ai-trend", "mode=duo"],
	])("deduplicates filtered content %s?%s", (path, query) => {
		const { metadata, header } = inspect(path!, query);
		expect(metadata.robots).toEqual({ index: false, follow: true });
		expect(header).toBe("noindex, follow");
	});
});
