import { StudioShell } from "@shared/components/studio/StudioShell";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";

import { PublicFooterLinks } from "../../../modules/public-content/components/PublicFooterLinks";
import type { PublicSearchParams } from "../../../modules/public-content/lib/indexing";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";
import { TemplateDirectory } from "../../../modules/video-templates/components/TemplateDirectory";

import "../../../modules/video-templates/video-templates.css";

export async function generateMetadata({
	searchParams,
}: {
	searchParams: Promise<PublicSearchParams>;
}) {
	const t = await getTranslations("videoTemplates");
	return createPublicPageMetadata({
		path: "/video-templates",
		title: t("title"),
		description: t("description"),
		index: false,
		searchParams: await searchParams,
	});
}
export default async function VideoTemplatesPage({
	searchParams,
}: {
	searchParams: Promise<PublicSearchParams>;
}) {
	const t = await getTranslations("videoTemplates");
	const messages = await getMessages();
	const search = await searchParams;
	const asset =
		typeof search.asset === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(search.asset)
			? search.asset
			: null;
	return (
		<StudioShell>
			<main className="vt-page">
				<header className="vt-intro">
					<span className="vt-eyebrow">{t("title")}</span>
					<h1>{t("subtitle")}</h1>
					<p>{t("description")}</p>
				</header>
				<NextIntlClientProvider messages={{ videoTemplates: messages.videoTemplates }}>
					<TemplateDirectory initialAssetId={asset} />
				</NextIntlClientProvider>
			</main>
			<footer className="vt-footer container">
				<PublicFooterLinks />
			</footer>
		</StudioShell>
	);
}
