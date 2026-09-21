import { LLMCopyButton } from "@docs/components/LLMCopyButton";
import { getPageImage, getPageMarkdownUrl, source } from "@docs/lib/source";
import { Footer } from "@shared/components/Footer";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getMDXComponents } from "../../../mdx-components";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export default async function DocumentationPage(props: PageProps<"/docs/[[...slug]]">) {
	const { slug } = await props.params;
	const page = source.getPage(slug);
	if (!page) notFound();

	const MDX = page.data.body;

	return (
		<main className="contents">
			<DocsPage toc={page.data.toc} full={page.data.full}>
				<DocsTitle>{page.data.title}</DocsTitle>
				<DocsDescription className="mb-0">{page.data.description}</DocsDescription>
				<div className="gap-2 pb-6 flex flex-row items-center border-b">
					<LLMCopyButton markdownUrl={getPageMarkdownUrl(page)} />
				</div>
				<DocsBody>
					<MDX
						components={getMDXComponents({
							a: createRelativeLink(source, page),
						})}
					/>
				</DocsBody>
				<Footer />
			</DocsPage>
		</main>
	);
}

export function generateStaticParams() {
	return source.generateParams();
}

export async function generateMetadata(props: PageProps<"/docs/[[...slug]]">): Promise<Metadata> {
	const { slug } = await props.params;
	const page = source.getPage(slug);
	if (!page) notFound();

	const metadata = createPublicPageMetadata({
		path: page.url,
		title: page.data.title,
		description: page.data.description ?? "",
		index: page.data.indexable,
	});
	return {
		...metadata,
		openGraph: {
			...metadata.openGraph,
			type: "article",
			images: [getPageImage(page).url],
		},
	};
}
