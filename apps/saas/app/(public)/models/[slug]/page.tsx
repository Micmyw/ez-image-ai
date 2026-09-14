import type { CreatePageFilters } from "@media/components/editor/RegisteredEditor";
import { notFound } from "next/navigation";

import { ModelPage } from "../../../../modules/models/components/ModelPage";
import {
	MODEL_PAGES,
	modelPageForSlug,
	modelPath,
} from "../../../../modules/models/lib/model-pages";
import { createPublicPageMetadata } from "../../../../modules/public-content/lib/metadata";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<CreatePageFilters> };
export function generateStaticParams() {
	return MODEL_PAGES.map((model) => ({ slug: model.key.slice(6) }));
}
export async function generateMetadata({ params }: Props) {
	const model = modelPageForSlug((await params).slug);
	if (!model) notFound();
	return createPublicPageMetadata({
		path: modelPath(model.key),
		title: `${model.name} AI Image Generator`,
		description: model.description,
		index: true,
	});
}
export default async function Page({ params, searchParams }: Props) {
	const model = modelPageForSlug((await params).slug);
	if (!model) notFound();
	return <ModelPage model={model} searchParams={searchParams} />;
}
