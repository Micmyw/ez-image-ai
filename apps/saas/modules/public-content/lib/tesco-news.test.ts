import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@shared/lib/base-url", () => ({ getBaseUrl: () => "https://ezimageai.test" }));

import { tescoMealPlanningDocuments } from "../../../content/posts/tesco-ai-meal-planning-assistant";
import { blogStructuredData } from "./blog-presentation";
import { BLOG_CATEGORIES, blogPath, type BlogPost } from "./blog-types";
import { validateBlogPosts } from "./blog-validation";
import { getAllPublishedBlogPosts, getBlogPostBySlug, getPublishedBlogPostPaths } from "./content";
import { createPublicPageMetadata } from "./metadata";

const article = tescoMealPlanningDocuments[0];
const officialSource = "https://www.tescoplc.com/interim-results-202627/";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Tesco AI news editorial and discovery contract", () => {
	it("records the employee trial and wider rollout separately from personalised prices", () => {
		expect(article.body).toMatch(/April 2026[^\n]+280,000 Tesco employees/);
		expect(article.body).toMatch(/September 2026[^\n]+start of a wider customer rollout/);
		expect(article.body).toContain("does not establish access for every Clubcard member");
		expect(article.body).not.toMatch(/23\s*(?:million|m)|all Clubcard members (?:can|have)/i);
		expect(article.body).toContain("Your Clubcard Prices** is a separate");
		expect(article.body).toMatch(
			/2\.5 million customers; this is not a meal-assistant access count/,
		);
		expect(article.body).toContain("current entry point is unverified");
		expect(article.body).toContain("We have not tested the feature in a live Tesco account");
		expect(article.sources).toEqual([
			{
				title: "Tesco PLC — Interim Results 2026/27, published 8 October 2026",
				url: officialSource,
				accessedAt: "2026-10-11",
			},
		]);
	});

	it("publishes one AI News article through the existing directory without a new category route", () => {
		expect(BLOG_CATEGORIES.filter((category) => category === "ai-news")).toHaveLength(1);
		const articles = getAllPublishedBlogPosts("en");
		expect(
			articles.filter((post) => post.categoryId === "ai-news").map((post) => post.slug),
		).toEqual([article.slug]);
		expect(getPublishedBlogPostPaths()).toContain(article.slug);
		expect(getPublishedBlogPostPaths().some((slug) => slug.startsWith("category/"))).toBe(false);
		expect(article.body).toContain("[AI News](/blog?category=ai-news)");
		expect(article.body).toContain("[EzImageAI Blog](/blog)");
		expect(new Set(articles.map((post) => post.title)).size).toBe(articles.length);
		expect(new Set(articles.map((post) => post.description)).size).toBe(articles.length);
	});

	it("requires dated public sources before publishing news", () => {
		expect(() => validateBlogPosts([article], [])).not.toThrow();
		expect(() => validateBlogPosts([{ ...article, sources: [] }], [])).toThrow(
			"news needs dated source records",
		);
		const undated: BlogPost = {
			...article,
			sources: [{ title: "Tesco interim results", url: officialSource }],
		};
		expect(() => validateBlogPosts([undated], [])).toThrow("news needs dated source records");
		expect(() => validateBlogPosts([{ ...undated, published: false }], [])).not.toThrow();
	});
});

describe("Tesco AI news SEO contract", () => {
	it("uses the same unique English canonical in metadata, Article and Breadcrumb data", () => {
		const canonical = `https://ezimageai.test${blogPath(article)}`;
		const metadata = createPublicPageMetadata({
			path: blogPath(article),
			title: article.title,
			description: article.description,
			index: true,
		});
		expect(metadata.alternates?.canonical).toBe(canonical);
		expect(metadata.description).toBe(article.description);
		expect(metadata.robots).toEqual({ index: true, follow: true });
		const [posting, breadcrumb] = blogStructuredData(article, "https://ezimageai.test", {
			home: "Home",
			blog: "Blog",
		})["@graph"];
		expect(posting).toMatchObject({
			"@type": "BlogPosting",
			url: canonical,
			headline: article.title,
			datePublished: "2026-10-11",
			inLanguage: "en",
		});
		expect(breadcrumb?.itemListElement?.at(-1)).toMatchObject({
			name: article.title,
			item: canonical,
		});
	});

	it("keeps English fallback and the AI News filter out of duplicate indexing", () => {
		expect(getBlogPostBySlug(article.slug, "fr")?.locale).toBe("en");
		const fallback = createPublicPageMetadata({
			path: blogPath(article),
			title: article.title,
			description: article.description,
			index: true,
			searchParams: { lang: "fr" },
		});
		expect(fallback.robots).toEqual({ index: false, follow: true });
		expect(fallback.alternates?.canonical).toBe(`https://ezimageai.test${blogPath(article)}`);
		const filtered = createPublicPageMetadata({
			path: "/blog",
			title: "Blog",
			description: "Blog posts",
			index: true,
			searchParams: { category: "ai-news" },
		});
		expect(filtered.robots).toEqual({ index: false, follow: true });
		expect(filtered.alternates?.canonical).toBe("https://ezimageai.test/blog");
	});
});
