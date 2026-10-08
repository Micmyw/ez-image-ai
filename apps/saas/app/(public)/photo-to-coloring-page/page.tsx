import { getBaseUrl } from "@shared/lib/base-url";

import {
	COLORING_DESCRIPTION,
	COLORING_PATH,
	COLORING_TITLE,
} from "../../../modules/coloring/lib/content";
import type { PublicMetadataProps } from "../../../modules/public-content/lib/indexing";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export { PhotoToColoringPage as default } from "../../../modules/coloring/components/PhotoToColoringPage";

export async function generateMetadata(props: PublicMetadataProps) {
	const { searchParams } = props ?? {};
	const base = createPublicPageMetadata({
		searchParams: await searchParams,
		path: COLORING_PATH,
		title: COLORING_TITLE,
		description: COLORING_DESCRIPTION,
		brandName: "EzImageAI",
		index: true,
	});
	const image = {
		url: new URL("/images/coloring/dog-coloring-page.webp", getBaseUrl()).href,
		width: 800,
		height: 1000,
		alt: "Illustrative dog coloring page with clean black outlines",
	};
	return {
		...base,
		openGraph: { ...base.openGraph, images: [image] },
		twitter: { ...base.twitter, images: [image.url] },
	};
}
