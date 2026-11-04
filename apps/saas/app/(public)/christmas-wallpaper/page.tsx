import { getBaseUrl } from "@shared/lib/base-url";

import {
	CHRISTMAS_DESCRIPTION,
	CHRISTMAS_PATH,
	CHRISTMAS_TITLE,
} from "../../../modules/christmas/lib/wallpaper";
import type { PublicMetadataProps } from "../../../modules/public-content/lib/indexing";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export { ChristmasWallpaperPage as default } from "../../../modules/christmas/components/ChristmasWallpaperPage";

export async function generateMetadata(props: PublicMetadataProps) {
	const { searchParams } = props ?? {};
	const base = createPublicPageMetadata({
		searchParams: await searchParams,
		path: CHRISTMAS_PATH,
		title: CHRISTMAS_TITLE,
		description: CHRISTMAS_DESCRIPTION,
		brandName: "EzImageAI",
		index: true,
	});
	const image = {
		url: new URL("/images/christmas/globe.webp", getBaseUrl()).href,
		width: 941,
		height: 1672,
		alt: "Christmas snow globe wallpaper",
	};
	return {
		...base,
		openGraph: { ...base.openGraph, images: [image] },
		twitter: { ...base.twitter, images: [image.url] },
	};
}
