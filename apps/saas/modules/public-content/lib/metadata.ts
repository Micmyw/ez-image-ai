import { config } from "@config";
import { getBaseUrl } from "@shared/lib/base-url";
import type { Metadata } from "next";

export function createPublicPageMetadata({
	path,
	title,
	description,
	index,
	brandName = config.appName,
}: {
	path: string;
	title: string;
	description: string;
	index: boolean;
	brandName?: string;
}): Metadata {
	const canonical = new URL(path, getBaseUrl()).href;
	const absoluteTitle = title.includes(brandName) ? title : `${title} | ${brandName}`;

	return {
		title: { absolute: absoluteTitle },
		description,
		alternates: { canonical },
		robots: { index, follow: true },
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
