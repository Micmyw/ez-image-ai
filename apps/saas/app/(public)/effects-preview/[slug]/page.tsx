import { getSession } from "@auth/lib/server";
import { notFound } from "next/navigation";

import { getEffectPreviewContent } from "../../../../modules/effects/lib/content";
import type { CreatePageFilters } from "../../../../modules/media/components/editor/RegisteredEditor";
import { PhotoIdeaArticle } from "../../../../modules/public-content/components/PhotoIdeaArticle";
import { getPhotoIdeaForPreview } from "../../../../modules/public-content/lib/content";

export const metadata = {
	title: "Photo Idea editorial preview | EzImageAI",
	robots: { index: false, follow: false },
};

export default async function EffectPreviewPage({
	params,
	searchParams,
}: {
	params: Promise<{ slug: string }>;
	searchParams: Promise<CreatePageFilters & { preset?: string }>;
}) {
	const session = await getSession();
	if (!session || session.user.role !== "admin" || session.user.isAnonymous) notFound();
	const effect = getEffectPreviewContent((await params).slug);
	if (!effect) notFound();
	const post = getPhotoIdeaForPreview(effect.id);
	if (!post) notFound();
	return <PhotoIdeaArticle post={post} recipe={effect} searchParams={searchParams} preview />;
}
