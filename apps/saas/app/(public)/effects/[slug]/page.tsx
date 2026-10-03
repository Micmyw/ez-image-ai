import { notFound } from "next/navigation";

import { EffectDetailPage } from "../../../../modules/effects/components/EffectDetailPage";
import { getPublishedEffectBySlug } from "../../../../modules/effects/lib/content";
import type { CreatePageFilters } from "../../../../modules/media/components/editor/RegisteredEditor";
import { createPublicPageMetadata } from "../../../../modules/public-content/lib/metadata";

type Props = {
	params: Promise<{ slug: string }>;
	searchParams: Promise<CreatePageFilters & { preset?: string; source?: string; from?: string }>;
};

export async function generateMetadata({ params }: Props) {
	const effect = getPublishedEffectBySlug((await params).slug);
	if (!effect) notFound();
	const metadata = createPublicPageMetadata({
		path: `/effects/${effect.slug}`,
		title: effect.seoTitle,
		description: effect.seoDescription,
		index: true,
	});
	const images = [
		{
			url: effect.cover.src,
			width: effect.cover.width,
			height: effect.cover.height,
			alt: effect.cover.alt,
		},
	];
	return {
		...metadata,
		openGraph: { ...metadata.openGraph, images },
		twitter: { ...metadata.twitter, images: [effect.cover.src] },
	};
}

export default async function EffectPage({ params, searchParams }: Props) {
	const effect = getPublishedEffectBySlug((await params).slug);
	if (!effect) notFound();
	const filters = await searchParams;
	const sources = ["effects-directory", "home", "image-to-image", "model", "effect"] as const;
	const internalSource = sources.find((value) => value === filters.from);
	return (
		<EffectDetailPage
			effect={effect}
			presetId={typeof filters.preset === "string" ? filters.preset : undefined}
			sourceBlogId={typeof filters.source === "string" ? filters.source : undefined}
			searchParams={searchParams}
			internalSource={internalSource}
		/>
	);
}
