import {
	getVideoTemplate,
	isFlyingCarTemplate,
	videoTemplateDescriptionKey,
} from "@repo/config/video-template-library";
import { StudioShell } from "@shared/components/studio/StudioShell";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PublicFooterLinks } from "../../../../modules/public-content/components/PublicFooterLinks";
import type { PublicSearchParams } from "../../../../modules/public-content/lib/indexing";
import { createPublicPageMetadata } from "../../../../modules/public-content/lib/metadata";
import { TemplateGuide } from "../../../../modules/video-templates/components/TemplateGuide";
import { TemplateWorkspace } from "../../../../modules/video-templates/components/TemplateWorkspace";

import "../../../../modules/video-templates/video-templates.css";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<PublicSearchParams> };
export async function generateMetadata({ params, searchParams }: Props) {
	const { slug } = await params;
	const template = getVideoTemplate(slug);
	if (!template || !template.canonicalPath.startsWith("/video-templates/")) notFound();
	const t = await getTranslations("videoTemplates");
	const key = videoTemplateDescriptionKey(template) as "original-rap";
	return createPublicPageMetadata({
		path: isFlyingCarTemplate(template.key)
			? "/video-templates/flying-car"
			: template.canonicalPath,
		title: t(`details.${key}.title`),
		description: t(`details.${key}.lead`),
		index: false,
		searchParams: await searchParams,
	});
}
export default async function VideoTemplatePage({ params, searchParams }: Props) {
	const { slug } = await params;
	const template = getVideoTemplate(slug);
	if (!template || !template.canonicalPath.startsWith("/video-templates/")) notFound();
	const t = await getTranslations("videoTemplates");
	const key = videoTemplateDescriptionKey(template) as "original-rap";
	const messages = await getMessages();
	const search = await searchParams;
	const identifier = (value: string | string[] | undefined) =>
		typeof value === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(value) ? value : null;
	return (
		<StudioShell>
			<main className="vt-page vt-detail-page">
				<header className="vt-intro">
					<nav aria-label={t("back")}>
						<Link
							href={
								identifier(search.asset)
									? `/video-templates?asset=${encodeURIComponent(identifier(search.asset)!)}`
									: "/video-templates"
							}
							prefetch={false}
						>
							← {t("back")}
						</Link>
					</nav>
					<span className="vt-eyebrow">{t(`categories.${template.category}`)}</span>
					<h1>{t(`details.${key}.title`)}</h1>
					<p>{t(`details.${key}.lead`)}</p>
				</header>
				<NextIntlClientProvider
					messages={{
						videoTemplates: messages.videoTemplates,
						videoV1: { output: messages.videoV1.output },
					}}
				>
					<TemplateWorkspace
						template={template}
						initialJobId={identifier(search.job)}
						initialAssetId={identifier(search.asset)}
					/>
				</NextIntlClientProvider>
				<TemplateGuide template={template} />
			</main>
			<footer className="vt-footer container">
				<PublicFooterLinks />
			</footer>
		</StudioShell>
	);
}
