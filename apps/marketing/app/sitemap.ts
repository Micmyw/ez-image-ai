import { getBaseUrl } from "@shared/lib/base-url";
import type { MetadataRoute } from "next";

const baseUrl = getBaseUrl();
const approvedEnglishPages = ["/", "/pricing", "/privacy", "/terms"];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
	return approvedEnglishPages.map((path) => ({
		url: new URL(path, baseUrl).href,
		lastModified: new Date(),
	}));
}
