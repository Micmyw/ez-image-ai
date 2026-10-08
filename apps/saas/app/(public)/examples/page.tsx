import { StudioShell } from "@shared/components/studio/StudioShell";
import { getLocale, getTranslations } from "next-intl/server";

import { ShowcaseSection } from "../../../modules/landing/components/ShowcaseSection";
import { PublicFooterLinks } from "../../../modules/public-content/components/PublicFooterLinks";
import type { PublicMetadataProps } from "../../../modules/public-content/lib/indexing";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export async function generateMetadata(props: PublicMetadataProps) {
	const { searchParams } = props ?? {};
	const locale = await getLocale();
	const t = await getTranslations();
	return createPublicPageMetadata({
		searchParams: await searchParams,
		path: "/examples",
		title: locale === "en" ? "AI Image Editing Examples" : t("home.showcase.title"),
		description:
			locale === "en"
				? "Browse original image ideas and choose a prompt to start creating with EzImageAI."
				: t("home.showcase.description"),
		index: true,
	});
}

export default function ExamplesPage() {
	return (
		<StudioShell>
			<main className="studio-home">
				<ShowcaseSection standalone />
				<footer className="py-8 container">
					<PublicFooterLinks className="gap-4 text-sm flex flex-wrap text-muted-foreground" />
				</footer>
			</main>
		</StudioShell>
	);
}
