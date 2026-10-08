import { getLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { PublicMarkdown } from "../../../modules/public-content/components/PublicMarkdown";
import { PublicPageShell } from "../../../modules/public-content/components/PublicPageShell";
import { getLegalPageByPath } from "../../../modules/public-content/lib/content";
import type { PublicMetadataProps } from "../../../modules/public-content/lib/indexing";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export async function generateMetadata(props: PublicMetadataProps) {
	const { searchParams } = props ?? {};
	const page = getLegalPageByPath("terms", { locale: await getLocale() });
	if (!page) return {};
	return createPublicPageMetadata({
		searchParams: await searchParams,
		path: "/terms",
		title: page.title,
		description: page.description,
		index: true,
	});
}

export default async function TermsPage() {
	const page = getLegalPageByPath("terms", { locale: await getLocale() });
	if (!page) notFound();

	return (
		<PublicPageShell title={page.title} description={page.description}>
			<PublicMarkdown body={page.body} />
		</PublicPageShell>
	);
}
