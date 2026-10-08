import { getLocale, getTranslations } from "next-intl/server";

import type { PublicMetadataProps } from "../../../modules/public-content/lib/indexing";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export { ImageToImagePage as default } from "../../../modules/landing/components/ImageToImagePage";

export async function generateMetadata(props: PublicMetadataProps) {
	const { searchParams } = props ?? {};
	const locale = await getLocale();
	const t = await getTranslations();
	return createPublicPageMetadata({
		searchParams: await searchParams,
		path: "/image-to-image",
		title: locale === "en" ? "Image to Image AI Generator" : t("imageToImage.title"),
		brandName: "EzImageAI",
		description:
			locale === "en"
				? "Upload a reference image and describe what to keep or change. Generate image variations, explore styles, and replace backgrounds with EzImageAI."
				: t("imageToImage.subtitle"),
		index: true,
	});
}
