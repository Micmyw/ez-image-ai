import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { eightiesPhotoEffect } from "../../../content/effects/1980s-ai-photo";
import { eightiesPhotoDocuments } from "../../../content/posts/1980s-ai-photo";
import { promptEditingDocuments } from "../../../content/posts/ai-image-editing-prompts";
import { blogDocuments } from "../../../content/posts/private-image-editing-workflow";
import * as effectContent from "../../effects/lib/content";
import { getContentHeadings, getReadingMinutes, parsePublicMarkdown } from "./blog-markdown";
import { blogStructuredData, serializeBlogJsonLd, toBlogCard } from "./blog-presentation";
import type { BlogPost } from "./blog-types";
import { validateBlogPosts } from "./blog-validation";
import {
	getAllPublishedBlogPosts,
	getBlogPostBySlug,
	getBlogPostsForEffect,
	getPublishedBlogPostPaths,
	getPublishedPhotoIdeaBySlug,
	getFeaturedPhotoIdeas,
	getPhotoIdeasForProduct,
	createBlogContentReader,
} from "./content";

const effectReferences = [{ id: "1980s-ai-photo", presets: [{ id: "studio-portrait" }] }];

describe("Blog publication and editorial relationships", () => {
	it("keeps both existing URLs, publication dates and English fallback", () => {
		expect(getPublishedBlogPostPaths().sort()).toEqual([
			"1980s-ai-photo",
			"ai-image-editing-prompts",
			"private-image-editing-workflow",
		]);
		expect(getBlogPostBySlug("ai-image-editing-prompts", "fr")?.publishedAt).toBe("2026-09-12");
		expect(getBlogPostBySlug("private-image-editing-workflow", "en")?.publishedAt).toBe(
			"2026-09-05",
		);
		expect(getBlogPostBySlug("private-image-editing-workflow", "de")?.body).toBe(
			blogDocuments[0].body,
		);
		expect(getBlogPostBySlug("missing-article", "en")).toBeNull();
	});

	it("exposes the published effect relationship in both directions while keeping cards compact", () => {
		expect(promptEditingDocuments[0].relatedEffectIds).toEqual(["1980s-ai-photo"]);
		expect(effectContent.getPublishedEffectById("1980s-ai-photo")?.status).toBe("published");
		const publicPosts = getAllPublishedBlogPosts("en");
		const promptPost = publicPosts.find((post) => post.id === "ai-image-editing-prompts");
		expect(promptPost?.relatedEffectIds).toEqual(["1980s-ai-photo"]);
		expect(promptPost?.primaryEffectId).toBe("1980s-ai-photo");
		expect(promptPost?.contentBlocks).toContainEqual(promptEditingDocuments[0].contentBlocks[0]);
		expect(getBlogPostsForEffect("1980s-ai-photo", "en").map((post) => post.id)).toEqual([
			"1980s-ai-photo",
			"ai-image-editing-prompts",
		]);
		expect(getBlogPostsForEffect("unknown", "en")).toEqual([]);
		const cards = publicPosts.map((post) => toBlogCard(post, "en"));
		expect(cards.every((card) => !("body" in card) && !("relatedEffectIds" in card))).toBe(true);
	});

	it("makes the article the only public identity for the shared tested recipe", () => {
		const idea = getPublishedPhotoIdeaBySlug("1980s-ai-photo")!;
		expect(idea.post.articleType).toBe("photo-ideas");
		expect(idea.post.categoryId).toBe("photo-ideas");
		expect(idea.post.recipeId).toBe(idea.recipe.id);
		expect(idea.recipe.presets).toHaveLength(3);
		expect(idea.recipe.lastTestedAt).toBe("2026-09-29");
		expect(idea.post.updatedAt).toBe("2026-10-04");
		expect(getFeaturedPhotoIdeas("en").map((post) => post.id)).toEqual([idea.post.id]);
		expect(getPhotoIdeasForProduct("image-nano-banana-2-lite", "en")).toEqual([idea.post]);
		expect(getPhotoIdeasForProduct("unavailable", "en")).toEqual([]);
	});

	it("hides a draft article even when its shared recipe remains approved", () => {
		const reader = createBlogContentReader([
			...promptEditingDocuments,
			{ ...eightiesPhotoDocuments[0], published: false },
		]);
		expect(reader.getPublishedPhotoIdeaBySlug("1980s-ai-photo")).toBeNull();
		expect(reader.getFeaturedPhotoIdeas("en")).toEqual([]);
		expect(reader.getPublishedBlogPostPaths()).toEqual(["ai-image-editing-prompts"]);
		expect(reader.getBlogPostBySlug("ai-image-editing-prompts", "en")?.relatedEffectIds).toEqual(
			[],
		);
		expect(reader.getPhotoIdeaForPreview("1980s-ai-photo")?.published).toBe(false);
	});

	it("filters a separately constructed unpublished fixture out of public Blog associations", () => {
		const draftReader = effectContent.createEffectContentReader([
			{
				...eightiesPhotoEffect,
				status: "draft",
				cover: undefined,
				examples: [],
				presets: eightiesPhotoEffect.presets.map((preset) => ({
					...preset,
					exampleIds: [],
					tests: [],
				})),
				publishedAt: undefined,
				lastTestedAt: undefined,
				featuredOrder: undefined,
			},
		]);
		expect(draftReader.getEffectPreviewContent("1980s-ai-photo")?.status).toBe("draft");
		const publishedLookup = vi
			.spyOn(effectContent, "getPublishedEffectById")
			.mockImplementation(draftReader.getPublishedEffectById);
		try {
			const publicPosts = getAllPublishedBlogPosts("en");
			expect(JSON.stringify(publicPosts)).not.toContain("1980s-ai-photo");
			expect(getBlogPostBySlug("ai-image-editing-prompts", "en")?.primaryEffectId).toBeUndefined();
			expect(getBlogPostBySlug("ai-image-editing-prompts", "en")?.contentBlocks).toEqual([]);
			expect(getBlogPostsForEffect("1980s-ai-photo", "en")).toEqual([]);
		} finally {
			publishedLookup.mockRestore();
		}
	});

	it("rejects unknown relationships, missing anchors and untested comparison claims", () => {
		const post: BlogPost = { ...promptEditingDocuments[0] };
		expect(() => validateBlogPosts([post], effectReferences)).not.toThrow();
		expect(() =>
			validateBlogPosts([{ ...post, primaryEffectId: "other" }], effectReferences),
		).toThrow("primary effect");
		expect(() =>
			validateBlogPosts([{ ...post, relatedEffectIds: ["missing"] }], effectReferences),
		).toThrow("related effect");
		expect(() =>
			validateBlogPosts(
				[
					{
						...post,
						contentBlocks: [{ ...post.contentBlocks![0]!, afterHeadingId: "missing-section" }],
					},
				],
				effectReferences,
			),
		).toThrow("insertion heading");
		expect(() =>
			validateBlogPosts([{ ...post, articleType: "comparisons" }], effectReferences),
		).toThrow("real test records");
		expect(() => validateBlogPosts([post, post], effectReferences)).toThrow("duplicate");
	});
});

describe("article presentation", () => {
	it("generates stable unique H2/H3 anchors without headings inside code or prompts", () => {
		const body =
			"## Repeat\n\n### Répeat\n\n## Repeat-2\n\n```prompt\n## Hidden\nkeep this line\n```\n\n## Repeat";
		expect(getContentHeadings(body).map((heading) => heading.id)).toEqual([
			"repeat",
			"repeat-2",
			"repeat-2-2",
			"repeat-3",
		]);
		expect(parsePublicMarkdown(body).find((block) => block.type === "prompt")).toEqual({
			type: "prompt",
			text: "## Hidden\nkeep this line",
		});
	});

	it("calculates reading time from actual article text", () => {
		expect(getReadingMinutes(Array.from({ length: 401 }, () => "word").join(" "))).toBe(3);
		expect(getReadingMinutes("[Read this](/a-very-long-route) **carefully**.")).toBe(1);
	});

	it("uses the true organization, dates and canonical page in safe structured data", () => {
		const post: BlogPost = { ...blogDocuments[0], title: "A </script> title" };
		const structured = blogStructuredData(post, "https://ezimageai.test", {
			home: "Home",
			blog: "Guides",
		});
		const serialized = serializeBlogJsonLd(structured);
		expect(serialized).not.toContain("</script>");
		const data = JSON.parse(serialized);
		expect(data["@graph"][0].author).toEqual({
			"@type": "Organization",
			name: "EzImageAI Editorial Team",
		});
		expect(data["@graph"][0].datePublished).toBe("2026-09-05");
		expect(data["@graph"][0].dateModified).toBe("2026-09-22");
		expect(data["@graph"][0].url).toBe(
			"https://ezimageai.test/blog/private-image-editing-workflow",
		);
		expect(data["@graph"][0]).not.toHaveProperty("image");
	});
});
