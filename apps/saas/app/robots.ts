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
				"/assets",
				"/create",
				"/draft/",
				"/edits",
				"/history",
				"/login",
				"/settings/",
				"/signup",
				"/try",
			],
		},
		sitemap: new URL("/sitemap.xml", getBaseUrl()).href,
	};
}
