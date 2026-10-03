import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PublicEffect } from "../modules/effects/lib/types";

const mocks = vi.hoisted(() => ({ published: vi.fn() }));
vi.mock("../modules/effects/lib/content", () => ({ getPublishedEffects: mocks.published }));
vi.mock("../modules/public-content/lib/content", () => ({ getAllPublishedBlogPosts: () => [] }));
vi.mock("../modules/public-content/components/PublicPageShell", () => ({
	PublicPageShell: ({ title, children }: { title: string; children: ReactNode }) => (
		<main>
			<h1>{title}</h1>
			{children}
		</main>
	),
}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("404");
	},
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next-intl/server", () => ({
	getLocale: async () => "en",
	getTranslations: async () => (key: string) => key,
}));

import EffectsPage, { generateMetadata } from "./(public)/effects/page";

// Public DTO fixtures only; no fixture is registered in the site's actual catalog.
function effects(count: number): PublicEffect[] {
	return Array.from(
		{ length: count },
		(_, index) =>
			({
				id: `recipe-${index + 1}`,
				slug: `recipe-${index + 1}`,
				title: `Recipe ${index + 1}`,
				summary: "A synthetic directory fixture.",
				seoTitle: "A directory test fixture",
				seoDescription: "Fixture metadata.",
				status: "published",
				trendStage: "none",
				defaultPresetId: "test-preset",
				presets: [],
				examples: [],
				instructions: [],
				limitations: [],
				faq: [],
				relatedEffectIds: [],
				publishedAt: "2026-09-29",
				updatedAt: "2026-09-29",
				lastTestedAt: "2026-09-29",
				primaryCategoryId: "retro-vintage",
				tags: [],
				cover: { src: "/images/effects/test/cover.webp", alt: "Fixture", width: 800, height: 1000 },
			}) as PublicEffect,
	);
}

afterEach(() => {
	vi.resetAllMocks();
	vi.unstubAllEnvs();
});

describe("Effects directory crawlability and pagination", () => {
	it("renders later-page cards and real navigation links in server HTML", async () => {
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://ezimageai.test");
		mocks.published.mockReturnValue(effects(25));
		const props = { searchParams: Promise.resolve({ page: "2" }) };
		const html = renderToStaticMarkup(await EffectsPage(props));
		expect(html.match(/class="effect-card"/g)).toHaveLength(12);
		expect(html).toContain('href="/effects/recipe-13?from=effects-directory"');
		expect(html).toContain('href="/effects/recipe-24?from=effects-directory"');
		expect(html).not.toContain('href="/effects/recipe-1?');
		expect(html).not.toContain('href="/effects/recipe-25?');
		expect(html).toContain('href="/effects?page=3"');
		expect((await generateMetadata(props)).alternates?.canonical).toBe(
			"https://ezimageai.test/effects?page=2",
		);
	});
	it("keeps an empty directory accessible, noindex and free of empty pagination", async () => {
		mocks.published.mockReturnValue([]);
		const html = renderToStaticMarkup(await EffectsPage({}));
		expect(html).toContain('href="/image-to-image"');
		expect(html).not.toContain('class="effect-card"');
		expect(html).not.toContain('class="effects-pagination"');
		expect((await generateMetadata({})).robots).toEqual({ index: false, follow: true });
	});
	it("returns 404 for malformed and nonexistent pages", async () => {
		mocks.published.mockReturnValue(effects(1));
		for (const page of ["2", "0", "01", ["1", "2"]]) {
			const props = { searchParams: Promise.resolve({ page }) };
			await expect(EffectsPage(props)).rejects.toThrow("404");
			await expect(generateMetadata(props)).rejects.toThrow("404");
		}
	});
});
