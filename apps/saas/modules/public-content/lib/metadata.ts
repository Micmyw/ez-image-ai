import { config } from "@config";
import { getBaseUrl } from "@shared/lib/base-url";
import type { Metadata } from "next";

import { publicPageIndexing, publicPagePath, type PublicSearchParams } from "./indexing";

export function createPublicPageMetadata({
	path,
	title,
	description,
	index,
	searchParams,
	brandName = config.appName,
}: {
	path: string;
	title: string;
	description: string;
	index: boolean;
	searchParams?: PublicSearchParams;
	brandName?: string;
}): Metadata {
	const policy = publicPageIndexing(path, searchParams);
	const canonical = new URL(policy.canonicalPath, getBaseUrl()).href;
	const absoluteTitle = title.includes(brandName) ? title : `${title} | ${brandName}`;

	return {
		title: { absolute: absoluteTitle },
		description,
		alternates: {
			canonical,
			...(policy.languages.length > 1
				? {
						languages: Object.fromEntries([
							...policy.languages.map((locale) => [
								locale,
								new URL(publicPagePath(path, locale), getBaseUrl()).href,
							]),
							["x-default", new URL(path, getBaseUrl()).href],
						]),
					}
				: {}),
		},
		robots: { index: index && policy.index, follow: policy.follow },
		openGraph: {
			siteName: brandName,
			title: absoluteTitle,
			description,
			type: "website",
			url: canonical,
		},
		twitter: {
			card: "summary_large_image",
			title: absoluteTitle,
			description,
		},
	};
}
