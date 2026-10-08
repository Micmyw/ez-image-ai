import { source } from "@docs/lib/source";
import { getBaseUrl } from "@shared/lib/base-url";
import type { MetadataRoute } from "next";

import { publicPageUpdates } from "../content/page-updates";
import { MODEL_PAGES, modelPath } from "../modules/models/lib/model-pages";
import {
	getAllPublishedBlogPosts,
	getLegalPageByPath,
	getPublicChangelogEntries,
} from "../modules/public-content/lib/content";
import { PUBLIC_PAGE_LANGUAGES, publicPagePath } from "../modules/public-content/lib/indexing";
import { CONTENT_PAGE_SIZE, contentPagePath } from "../modules/public-content/lib/pagination";
import { getIndexableVideoEffects } from "../modules/video-effects/lib/content";

export default function sitemap(): MetadataRoute.Sitemap {
	const baseUrl = getBaseUrl();
	const posts = getAllPublishedBlogPosts("en");
	const pages = [
		...publicPageUpdates,
		// No invented dates for pages without a maintained editorial timestamp.
		{ path: "/create", lastModified: undefined },
		{ path: "/examples", lastModified: undefined },
		{ path: "/contact", lastModified: undefined },
		{
			path: "/changelog",
			lastModified: getPublicChangelogEntries()
				.map((entry) => entry.date)
				.sort()
				.at(-1),
		},
		...getIndexableVideoEffects().map((effect) => ({
			path: effect.path,
			lastModified: effect.updatedAt ?? effect.publishedAt,
		})),
		...Array.from(
			{ length: Math.max(0, Math.ceil(posts.length / CONTENT_PAGE_SIZE) - 1) },
			(_, index) => ({
				path: contentPagePath("/blog", index + 2),
				lastModified: posts
					.map((post) => post.updatedAt ?? post.publishedAt)
					.sort()
					.at(-1),
			}),
		),
		{
			path: "/privacy",
			lastModified: getLegalPageByPath("privacy-policy", { locale: "en" })?.updatedAt,
		},
		{ path: "/terms", lastModified: getLegalPageByPath("terms", { locale: "en" })?.updatedAt },
		{
			path: "/blog",
			lastModified: posts
				.map((post) => post.updatedAt ?? post.publishedAt)
				.sort()
				.at(-1),
		},
		{
			path: "/models",
			lastModified: MODEL_PAGES.map((model) => model.updatedAt)
				.sort()
				.at(-1),
		},
		...MODEL_PAGES.map((model) => ({ path: modelPath(model.key), lastModified: model.updatedAt })),
		...posts.map((post) => ({
			path: `/blog/${post.slug}`,
			lastModified: post.updatedAt ?? post.publishedAt,
		})),
		...source
			.getPages()
			.filter((page) => page.data.indexable)
			.map((page) => ({ path: page.url, lastModified: page.data.updatedAt })),
	];
	return pages.flatMap(({ path, lastModified }) => {
		const languages = PUBLIC_PAGE_LANGUAGES[path] ?? ["en"];
		return languages.map((locale) => ({
			url: new URL(publicPagePath(path, locale), baseUrl).href,
			lastModified,
			...(languages.length > 1
				? {
						alternates: {
							languages: Object.fromEntries([
								...languages.map((language) => [
									language,
									new URL(publicPagePath(path, language), baseUrl).href,
								]),
								["x-default", new URL(path, baseUrl).href],
							]),
						},
					}
				: {}),
		}));
	});
}
