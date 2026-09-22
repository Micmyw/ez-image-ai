import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as content from "../modules/public-content/lib/content";
import sitemap from "./sitemap";

describe("consolidated SaaS sitemap", () => {
	beforeEach(() => {
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://www.ezpic.test");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("publishes exactly the approved same-origin public routes", () => {
		const entries = sitemap();
		const urls = entries.map(({ url }) => new URL(url));

		expect(urls.map(({ pathname }) => pathname).sort()).toEqual(
			[
				"/",
				"/image-to-image",
				"/pricing",
				"/privacy",
				"/terms",
				"/blog",
				"/models",
				"/models/nano-banana-2-lite",
				"/models/nano-banana",
				"/models/nano-banana-2",
				"/models/nano-banana-pro",
				"/models/gpt-image-1-5",
				"/models/gpt-image-2",
				"/models/gpt-image-2-5-flare",
				"/models/gpt-image-2-5-sunburst",
				"/models/seedream-4",
				"/models/seedream-4-5",
				"/models/seedream-5-lite",
				"/models/seedream-5-pro",
				"/blog/private-image-editing-workflow",
				"/blog/ai-image-editing-prompts",
				"/docs",
				"/docs/quick-start",
				"/docs/image-editing",
				"/docs/credits",
				"/docs/privacy",
			].sort(),
		);
		expect(urls.every(({ origin }) => origin === "https://www.ezpic.test")).toBe(true);
		expect(new Set(urls.map(({ href }) => href)).size).toBe(urls.length);
	});

	it("publishes recorded content dates for every approved page", () => {
		const entries = sitemap();
		for (const entry of entries) {
			expect(entry.lastModified, entry.url).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
		const dates = Object.fromEntries(
			entries.map((entry) => [new URL(entry.url).pathname, entry.lastModified]),
		);
		expect(dates).toMatchObject({
			"/": "2026-09-21",
			"/image-to-image": "2026-09-21",
			"/pricing": "2026-09-16",
			"/privacy": "2026-09-22",
			"/terms": "2026-09-22",
			"/blog": "2026-09-22",
			"/blog/ai-image-editing-prompts": "2026-09-12",
			"/blog/private-image-editing-workflow": "2026-09-22",
			"/models": "2026-09-16",
			"/docs": "2026-09-18",
			"/docs/credits": "2026-09-16",
			"/docs/image-editing": "2026-09-22",
			"/docs/privacy": "2026-09-22",
			"/docs/quick-start": "2026-09-22",
		});
	});

	it("does not advance modification dates when rebuilding unchanged content", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-01"));
		const original = sitemap();
		vi.setSystemTime(new Date("2027-01-01"));
		expect(sitemap()).toEqual(original);
	});

	it("uses a revised article date and propagates the latest date to the blog index", () => {
		vi.spyOn(content, "getAllPublishedBlogPosts").mockReturnValue([
			{
				...content.getAllPublishedBlogPosts("en")[0]!,
				publishedAt: "2026-09-01",
				updatedAt: "2026-09-20",
			},
		]);
		const entries = sitemap();
		expect(entries.find(({ url }) => url.endsWith("/blog"))?.lastModified).toBe("2026-09-20");
		expect(entries.find(({ url }) => url.includes("/blog/"))?.lastModified).toBe("2026-09-20");
	});
});
