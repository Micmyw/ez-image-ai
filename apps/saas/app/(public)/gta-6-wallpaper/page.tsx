import type { CreatePageFilters } from "@media/components/editor/RegisteredEditor";
import { getBaseUrl } from "@shared/lib/base-url";

import { GtaPage } from "../../../modules/gta/components/GtaPage";
import { GTA_PAGES } from "../../../modules/gta/lib/config";
import { GTA_EXAMPLES } from "../../../modules/gta/lib/examples";
import type { PublicMetadataProps } from "../../../modules/public-content/lib/indexing";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export default function Page({ searchParams }: { searchParams?: Promise<CreatePageFilters> }) {
	return <GtaPage intent="wallpaper" searchParams={searchParams} />;
}

export async function generateMetadata({ searchParams }: PublicMetadataProps) {
	const page = GTA_PAGES.wallpaper;
	const base = createPublicPageMetadata({
		searchParams: await searchParams,
		path: page.path,
		title: page.title,
		description: page.description,
		brandName: "EzImageAI",
		index: true,
	});
	const example = GTA_EXAMPLES.find(
		(item) => item.intent === "wallpaper" && item.format === "desktop",
	)!;
	const image = {
		url: new URL(example.src, getBaseUrl()).href,
		width: example.width,
		height: example.height,
		alt: example.alt,
	};
	return {
		...base,
		openGraph: { ...base.openGraph, images: [image] },
		twitter: { ...base.twitter, images: [image.url] },
	};
}
