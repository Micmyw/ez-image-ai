import { describe, expect, it } from "vitest";

import {
	BLOG_AD_ARTICLE_PATHS,
	BLOG_AD_ORIGIN,
	getArticleDocumentNavigationTarget,
	isBlogAdArticlePath,
	requiresArticleDocumentNavigation,
	type ArticleAnchorNavigation,
} from "./blog-ad-routing";
import { blogPath } from "./blog-types";
import { getAllPublishedBlogPosts } from "./content";

const origin = "https://ezimageai.com";
const article = "/blog/tesco-ai-meal-planning-assistant";

describe("article response policy routing", () => {
	it("allows only reviewed published ordinary articles and one dedicated advertising origin", () => {
		expect(BLOG_AD_ORIGIN).toBe("https://ads.ezimageai.com");
		const ordinaryPaths = getAllPublishedBlogPosts("en")
			.filter((post) => !post.recipeId && post.videoEffect !== "raindance")
			.map(blogPath);
		expect(BLOG_AD_ARTICLE_PATHS).toHaveLength(3);
		for (const path of BLOG_AD_ARTICLE_PATHS) expect(ordinaryPaths).toContain(path);
		expect(ordinaryPaths).toContain("/blog/vidu-q4-preview");
		expect(isBlogAdArticlePath("/blog/vidu-q4-preview")).toBe(false);
	});

	it.each([
		"/",
		"/create",
		"/pricing",
		"/settings/billing",
		"/blog",
		"/blog/1980s-ai-photo",
		"/blog/raindance-ai-trend",
		"/blog/how-to-make-hotel-lobby-ai-video",
		"/blog/vidu-q4-preview",
		"/blog/unpublished",
		`${article}/extra`,
		`${article}/`,
		`${article}?lang=de`,
	])("does not give %s an article response policy", (path) => {
		expect(isBlogAdArticlePath(path)).toBe(false);
	});

	it.each([
		["/create", article, true],
		[article, "/", true],
		[article, "/pricing", true],
		[article, "/settings/billing", true],
		[article, "/blog/1980s-ai-photo", true],
		[article, BLOG_AD_ARTICLE_PATHS[0], true],
		[article, article, false],
		["/create", "/pricing", false],
		["/blog", "/blog/raindance-ai-trend", false],
	] as const)("document boundary %s → %s is %s", (from, to, required) => {
		expect(requiresArticleDocumentNavigation(from, to)).toBe(required);
	});

	it("preserves the destination query and fragment without sending them anywhere else", () => {
		expect(
			getArticleDocumentNavigationTarget(`${origin}/blog`, `${article}?lang=de#sources`, {
				button: 0,
			}),
		).toBe(`${origin}${article}?lang=de#sources`);
	});

	it.each([
		{ button: 1 },
		{ button: 2 },
		{ button: 0, altKey: true },
		{ button: 0, ctrlKey: true },
		{ button: 0, metaKey: true },
		{ button: 0, shiftKey: true },
		{ button: 0, defaultPrevented: true },
		{ button: 0, target: "_blank" },
		{ button: 0, target: "_parent" },
		{ button: 0, target: "report-window" },
		{ button: 0, download: true },
		{ button: 0, disabled: true },
	] satisfies ArticleAnchorNavigation[])("preserves link semantics for %j", (options) => {
		expect(getArticleDocumentNavigationTarget(`${origin}/blog`, article, options)).toBeNull();
	});

	it.each([null, "", "_self", "_SELF"])("accepts an ordinary target %s", (target) => {
		expect(
			getArticleDocumentNavigationTarget(`${origin}/blog`, article, { button: 0, target }),
		).toBe(`${origin}${article}`);
	});

	it.each([
		`https://other.example${article}`,
		`http://ezimageai.com${article}`,
		`https://ezimageai.com:8443${article}`,
		`https://ads.ezimageai.com${article}`,
		`https://user:pass@ezimageai.com${article}`,
		"javascript:alert(1)",
		"mailto:help@example.com",
		"data:text/html,test",
		"https://[invalid",
	])("does not intercept external or invalid destination %s", (destination) => {
		expect(
			getArticleDocumentNavigationTarget(`${origin}${article}`, destination, { button: 0 }),
		).toBeNull();
	});

	it.each(["#sources", "?lang=de", `${article}#sources`, `${article}?lang=fr#sources`])(
		"retains same-article navigation for %s",
		(destination) => {
			expect(
				getArticleDocumentNavigationTarget(`${origin}${article}`, destination, { button: 0 }),
			).toBeNull();
		},
	);

	it("leaves ordinary product navigation and invalid base URLs untouched", () => {
		expect(
			getArticleDocumentNavigationTarget(`${origin}/create`, "/pricing", { button: 0 }),
		).toBeNull();
		expect(getArticleDocumentNavigationTarget("invalid", article, { button: 0 })).toBeNull();
	});
});
