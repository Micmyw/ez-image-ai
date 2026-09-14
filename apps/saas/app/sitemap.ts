import { source } from "@docs/lib/source";
import { getBaseUrl } from "@shared/lib/base-url";
import type { MetadataRoute } from "next";

import { MODEL_PAGES, modelPath } from "../modules/models/lib/model-pages";
import { getPublishedBlogPostPaths } from "../modules/public-content/lib/content";

export default function sitemap(): MetadataRoute.Sitemap {
	const baseUrl = getBaseUrl();
	const paths = [
		"/",
		"/pricing",
		"/privacy",
		"/terms",
		"/blog",
		"/models",
		...MODEL_PAGES.map((model) => modelPath(model.key)),
		...getPublishedBlogPostPaths().map((slug) => `/blog/${slug}`),
		...source
			.getPages()
			.filter((page) => page.data.indexable)
			.map((page) => page.url),
	];
	return paths.map((path) => ({
		url: new URL(path, baseUrl).href,
	}));
}
