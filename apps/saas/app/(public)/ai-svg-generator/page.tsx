import { ImageToolPage } from "../../../modules/image-tools/components/ImageToolPage";
import { IMAGE_TOOL_PAGES } from "../../../modules/image-tools/lib/tool-pages";
import type { CreatePageFilters } from "../../../modules/media/components/editor/RegisteredEditor";
import type { PublicMetadataProps } from "../../../modules/public-content/lib/indexing";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export async function generateMetadata(props: PublicMetadataProps = {}) {
	const content = IMAGE_TOOL_PAGES["ai-svg-generator"];
	return createPublicPageMetadata({
		...content,
		searchParams: await props.searchParams,
		brandName: "EzImageAI",
		index: true,
	});
}

export default function Page({ searchParams }: { searchParams?: Promise<CreatePageFilters> } = {}) {
	return <ImageToolPage tool="ai-svg-generator" searchParams={searchParams} />;
}
