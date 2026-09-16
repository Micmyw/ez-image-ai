import { getBaseUrl } from "@shared/lib/base-url";
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
	return {
		rules: {
			userAgent: "*",
			allow: "/",
			disallow: [
				"/api/",
				"/admin/",
				"/assets", // Private asset library; public artwork lives under /images/ and /examples/.
				"/create",
				"/draft/",
				"/edits",
				"/history",
				"/settings/",
				"/try",
			],
		},
		sitemap: ["/sitemap.xml", "/sitemap-images.xml"].map(
			(path) => new URL(path, getBaseUrl()).href,
		),
	};
}
