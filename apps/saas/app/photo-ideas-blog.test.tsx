import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next-intl/server", () => ({
	getLocale: async () => "en",
	getTranslations: async () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("404");
	},
}));
vi.mock("../modules/public-content/components/PhotoIdeaArticle", () => ({
	PhotoIdeaArticle: () => null,
}));
vi.mock("../modules/public-content/components/IllustratedPhotoIdeaArticle", () => ({
	IllustratedPhotoIdeaArticle: () => null,
}));

import * as recipes from "../modules/effects/lib/content";
import { blogStructuredData } from "../modules/public-content/lib/blog-presentation";
import BlogArticlePage, {
	generateMetadata,
	generateStaticParams,
} from "./(public)/blog/[...path]/page";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("canonical Blog Photo Idea", () => {
	it("publishes the paid Sheru idea with honest illustrations and an indexable canonical", async () => {
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://ezimageai.test");
		const params = Promise.resolve({ path: ["sheru-bhai-ai-photo"] });
		const metadata = await generateMetadata({ params });
		expect(metadata.robots).toEqual({ index: true, follow: true });
		expect(metadata.alternates?.canonical).toBe("https://ezimageai.test/blog/sheru-bhai-ai-photo");
		expect(generateStaticParams()).toContainEqual({ path: ["sheru-bhai-ai-photo"] });
		const page = await BlogArticlePage({ params });
		expect(page.props.recipe.generationAccess).toBe("paid");
		expect(page.props.recipe.presentation).toBe("illustrations");
		expect(page.props.recipe.examples).toHaveLength(0);
		expect(page.props.recipe.lastTestedAt).toBeUndefined();
		expect(page.props.recipe.illustrations).toHaveLength(2);
		expect(JSON.stringify(page.props.recipe)).not.toMatch(/provenance|verifiedAt|docs\/product/);
		for (const preset of page.props.recipe.presets) {
			expect(preset.productKey).toBe("image-nano-banana-2");
			expect(preset.parameters.skuKey).toBe("nano-banana-2-1k");
			expect(preset).not.toHaveProperty("tests");
		}
		const privateMetadata = await generateMetadata({
			params,
			searchParams: Promise.resolve({ job: "owned-job" }),
		});
		expect(privateMetadata.robots).toEqual({ index: false, follow: false });
	});
	it("owns article metadata and one canonical, independent of preset selection", async () => {
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://ezimageai.test");
		const metadata = await generateMetadata({
			params: Promise.resolve({ path: ["1980s-ai-photo"] }),
		});
		expect(metadata.alternates?.canonical).toBe("https://ezimageai.test/blog/1980s-ai-photo");
		expect(metadata.title).toEqual({
			absolute: expect.stringContaining("1980s AI Photo Ideas & Prompts"),
		});
		expect(metadata.robots).toEqual({ index: true, follow: true });
		expect(metadata.openGraph).toMatchObject({
			type: "article",
			publishedTime: "2026-09-29",
			modifiedTime: "2026-10-04",
		});
		expect(generateStaticParams()).toContainEqual({ path: ["1980s-ai-photo"] });
	});
	it("attaches the same sanitized recipe that supplies prompts, output matches and the editor", async () => {
		const page = await BlogArticlePage({
			params: Promise.resolve({ path: ["1980s-ai-photo"] }),
			searchParams: Promise.resolve({ preset: "family-snapshot" }),
		});
		expect(page.props.post.recipeId).toBe(page.props.recipe.id);
		expect(page.props.post.articleType).toBe("photo-ideas");
		expect(page.props.recipe.presets).toHaveLength(3);
		for (const preset of page.props.recipe.presets) {
			expect(
				page.props.recipe.examples.some(
					(example: { presetId: string; presetVersion: number }) =>
						example.presetId === preset.id && example.presetVersion === preset.version,
				),
			).toBe(true);
			expect(preset).not.toHaveProperty("tests");
		}
		expect(JSON.stringify(page.props.recipe)).not.toContain("docs/product/evidence/");
		const structured = blogStructuredData(page.props.post, "https://ezimageai.test", {
			home: "Home",
			blog: "Blog",
		});
		expect(JSON.stringify(structured)).toContain("https://ezimageai.test/blog/1980s-ai-photo");
		expect(JSON.stringify(structured)).not.toContain("/effects/");
	});
	it("fails closed when the attached tested recipe is unavailable", async () => {
		vi.spyOn(recipes, "getPublishedEffectById").mockReturnValue(null);
		await expect(
			BlogArticlePage({ params: Promise.resolve({ path: ["1980s-ai-photo"] }) }),
		).rejects.toThrow("404");
		await expect(
			generateMetadata({ params: Promise.resolve({ path: ["1980s-ai-photo"] }) }),
		).rejects.toThrow("404");
		expect(generateStaticParams()).not.toContainEqual({ path: ["1980s-ai-photo"] });
	});
});
