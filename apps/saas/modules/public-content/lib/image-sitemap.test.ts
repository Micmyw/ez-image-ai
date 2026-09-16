import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import sitemap from "../../../app/sitemap";
import { GET } from "../../../app/sitemap-images.xml/route";
import { getPublicImageSitemapEntries } from "./image-sitemap";

const baseUrl = "https://www.ezpic.test";
const publicRoot = path.resolve(import.meta.dirname, "../../../public");

afterEach(() => vi.unstubAllEnvs());

describe("public image sitemap", () => {
	it("lists packaged public artwork only on indexable pages", () => {
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", baseUrl);
		const pageUrls = new Set(sitemap().map(({ url }) => url));
		const entries = getPublicImageSitemapEntries(baseUrl);
		expect(entries).toHaveLength(14);
		expect(new Set(entries.map(({ url }) => url)).size).toBe(entries.length);
		for (const entry of entries) {
			expect(pageUrls.has(entry.url), entry.url).toBe(true);
			expect(entry.images.length).toBeGreaterThan(0);
			expect(entry.images.length).toBeLessThanOrEqual(1000);
			expect(new Set(entry.images).size).toBe(entry.images.length);
			for (const image of entry.images) {
				const url = new URL(image);
				expect(url.origin).toBe(baseUrl);
				expect(url.pathname).toMatch(/^\/images\/(landing|models)\/variants\/.+\.webp$/);
				expect(url.search).toBe("");
				expect(existsSync(path.join(publicRoot, url.pathname)), image).toBe(true);
			}
		}
	});

	it("covers the homepage recipes and both stages of the coloring example", () => {
		const entries = getPublicImageSitemapEntries(baseUrl);
		const home = entries.find(({ url }) => url === `${baseUrl}/`)!;
		expect(home.images).toHaveLength(15);
		expect(home.images.filter((image) => image.includes("/case-"))).toHaveLength(12);
		expect(home.images.some((image) => image.includes("case-mediterranean-room-"))).toBe(true);
		const coloring = entries.find(({ url }) => url.endsWith("/models/nano-banana-2"))!;
		expect(coloring.images).toHaveLength(6);
		expect(coloring.images.some((image) => image.includes("nano-2-coloring-before-"))).toBe(true);
		expect(coloring.images.some((image) => image.includes("nano-2-coloring-after-"))).toBe(true);
	});

	it("serves the supported XML namespace and image URLs without deprecated tags", async () => {
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", baseUrl);
		const response = GET();
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
		const xml = await response.text();
		expect(xml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
		for (const { url, images } of getPublicImageSitemapEntries(baseUrl)) {
			expect(xml).toContain(`<loc>${url}</loc>`);
			for (const image of images) expect(xml).toContain(`<image:loc>${image}</image:loc>`);
		}
		expect(xml).not.toMatch(/<image:(title|caption|geo_location|license)>/);
	});
});
