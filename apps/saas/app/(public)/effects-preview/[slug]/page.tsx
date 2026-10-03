import { getSession } from "@auth/lib/server";
import { notFound } from "next/navigation";

import { EffectDetailPage } from "../../../../modules/effects/components/EffectDetailPage";
import { getEffectPreviewContent } from "../../../../modules/effects/lib/content";
import type { CreatePageFilters } from "../../../../modules/media/components/editor/RegisteredEditor";

export const metadata = {
	title: "Effect editorial preview | EzImageAI",
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
	const filters = await searchParams;
	return (
		<EffectDetailPage
			effect={effect}
			presetId={typeof filters.preset === "string" ? filters.preset : undefined}
			searchParams={searchParams}
			preview
		/>
	);
}
