import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export { ImageToImagePage as default } from "../../../modules/landing/components/ImageToImagePage";

export const metadata = createPublicPageMetadata({
	path: "/image-to-image",
	title: "Image to Image AI Generator",
	brandName: "EzImageAI",
	description:
		"Upload a reference image and describe what to keep or change. Generate image variations, explore styles, and replace backgrounds with EzImageAI.",
	index: true,
});
