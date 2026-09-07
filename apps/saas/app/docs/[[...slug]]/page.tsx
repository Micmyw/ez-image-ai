import { LLMCopyButton } from "@docs/components/LLMCopyButton";
import { getPageImage, getPageMarkdownUrl, source } from "@docs/lib/source";
import { getBaseUrl } from "@shared/lib/base-url";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getMDXComponents } from "../../../mdx-components";

export default async function DocumentationPage(props: PageProps<"/docs/[[...slug]]">) {
	const { slug } = await props.params;
	const page = source.getPage(slug);
	if (!page) notFound();

	const MDX = page.data.body;

	return (
		<main>
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

	const canonical = new URL(page.url, getBaseUrl()).href;
	return {
		title: page.data.title,
		description: page.data.description,
		alternates: { canonical },
		robots: { index: false, follow: true },
		openGraph: {
			title: page.data.title,
			description: page.data.description,
			type: "article",
			url: canonical,
			images: [getPageImage(page).url],
		},
	};
}
