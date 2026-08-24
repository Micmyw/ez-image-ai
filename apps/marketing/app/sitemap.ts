import { config as i18nConfig } from "@i18n/config";
import { getBaseUrl } from "@shared/lib/base-url";
import { getUniqueBasePaths } from "@shared/lib/content";
import { allLegalPages } from "content-collections";
import type { MetadataRoute } from "next";

const baseUrl = getBaseUrl();
const defaultLocale = i18nConfig.defaultLocale;

function localePath(locale: string, path: string): string {
	const prefix = locale === defaultLocale ? "" : `/${locale}`;
	return `${prefix}${path}`;
}

const staticMarketingPages = [""];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
	const legalPaths = getUniqueBasePaths(allLegalPages);

	return [
		...staticMarketingPages.map((page) => ({
			url: new URL(localePath(defaultLocale, page), baseUrl).href,
			lastModified: new Date(),
		})),
		...legalPaths.map((path) => ({
			url: new URL(localePath(defaultLocale, `/legal/${path}`), baseUrl).href,
			lastModified: new Date(),
		})),
	];
}
