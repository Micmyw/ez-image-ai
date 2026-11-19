import { PORTRAIT_PACK_PATH } from "@repo/config/portrait-packs";
import { getTranslations } from "next-intl/server";

import { PortraitPackExperience } from "../../../modules/portrait-packs/components/PortraitPackExperience";
import { PublicPageShell } from "../../../modules/public-content/components/PublicPageShell";
import type { PublicMetadataProps } from "../../../modules/public-content/lib/indexing";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export async function generateMetadata({ searchParams }: PublicMetadataProps) {
	const t = await getTranslations("portraitPacks");
	return createPublicPageMetadata({
		path: PORTRAIT_PACK_PATH,
		title: t("name"),
		description: t("pageDescription"),
		searchParams: await searchParams,
		index: true,
	});
}

export default async function PortraitPacksPage() {
	const t = await getTranslations("portraitPacks");
	return (
		<PublicPageShell title={t("name")} description={t("pageDescription")} compact>
			<div className="max-w-6xl mx-auto">
				<PortraitPackExperience />
				<p className="mt-5 text-sm leading-relaxed text-slate-300 text-center">{t("terms")}</p>
			</div>
		</PublicPageShell>
	);
}
