import { LLMCopyButton } from "@docs/components/LLMCopyButton";
import { getPageImage, getPageMarkdownUrl, source } from "@docs/lib/source";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import Link from "next/link";
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
				<header className="docs-article-header">
					<p className="docs-eyebrow">EZIMAGEAI · HELP CENTER</p>
					<DocsTitle id="docs-content" tabIndex={-1}>
						{page.data.title}
					</DocsTitle>
					<DocsDescription>{page.data.description}</DocsDescription>
				</header>
				<DocsBody className="docs-prose">
					<MDX
						components={getMDXComponents({
							a: createRelativeLink(source, page),
						})}
					/>
				</DocsBody>
				<footer className="docs-article-footer">
					<div>
						<p>Still need a hand?</p>
						<Link href="/contact">
							Contact support <span aria-hidden>↗</span>
						</Link>
					</div>
					<LLMCopyButton markdownUrl={getPageMarkdownUrl(page)} />
				</footer>
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
