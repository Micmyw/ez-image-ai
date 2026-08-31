import { getBaseUrl } from "@shared/lib/base-url";
import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
	return [
		{
			url: new URL("/", getBaseUrl()).href,
			lastModified: new Date(),
			changeFrequency: "weekly",
			priority: 1,
		},
	];
}
