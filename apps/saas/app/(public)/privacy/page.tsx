import { getLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { PublicMarkdown } from "../../../modules/public-content/components/PublicMarkdown";
import { PublicPageShell } from "../../../modules/public-content/components/PublicPageShell";
import { getLegalPageByPath } from "../../../modules/public-content/lib/content";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export async function generateMetadata() {
	const page = getLegalPageByPath("privacy-policy", { locale: await getLocale() });
	if (!page) return {};
	return createPublicPageMetadata({
		path: "/privacy",
		title: page.title,
		description: page.description,
		index: true,
	});
}

export default async function PrivacyPage() {
	const page = getLegalPageByPath("privacy-policy", { locale: await getLocale() });
	if (!page) notFound();

	return (
		<PublicPageShell title={page.title} description={page.description}>
			<PublicMarkdown body={page.body} />
		</PublicPageShell>
	);
}
