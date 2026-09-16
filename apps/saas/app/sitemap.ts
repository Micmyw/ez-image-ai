import { source } from "@docs/lib/source";
import { getBaseUrl } from "@shared/lib/base-url";
import type { MetadataRoute } from "next";

import { publicPageUpdates } from "../content/page-updates";
import { MODEL_PAGES, modelPath } from "../modules/models/lib/model-pages";
import {
	getAllPublishedBlogPosts,
	getLegalPageByPath,
} from "../modules/public-content/lib/content";

export default function sitemap(): MetadataRoute.Sitemap {
	const baseUrl = getBaseUrl();
	const posts = getAllPublishedBlogPosts("en");
	const pages = [
		...publicPageUpdates,
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
	return pages.map(({ path, lastModified }) => ({
		url: new URL(path, baseUrl).href,
		lastModified,
	}));
}
