import { getBaseUrl } from "@shared/lib/base-url";
import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
	const baseUrl = getBaseUrl();
	return ["/", "/pricing", "/privacy", "/terms"].map((path, index) => ({
		url: new URL(path, baseUrl).href,
		lastModified: new Date(),
		changeFrequency: "weekly",
		priority: index === 0 ? 1 : 0.7,
	}));
}
