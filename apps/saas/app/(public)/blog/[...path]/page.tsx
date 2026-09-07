import { getLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { PublicMarkdown } from "../../../../modules/public-content/components/PublicMarkdown";
import { PublicPageShell } from "../../../../modules/public-content/components/PublicPageShell";
import {
	getBlogPostBySlug,
	getPublishedBlogPostPaths,
} from "../../../../modules/public-content/lib/content";
import { createPublicPageMetadata } from "../../../../modules/public-content/lib/metadata";

type BlogPageParams = { path: string | string[] };

export function generateStaticParams() {
	return getPublishedBlogPostPaths().map((path) => ({ path: [path] }));
}

export async function generateMetadata({ params }: { params: Promise<BlogPageParams> }) {
	const { path } = await params;
	const slug = normalizePath(path);
	const post = getBlogPostBySlug(slug, await getLocale());
	if (!post) return {};
	return createPublicPageMetadata({
		path: `/blog/${post.slug}`,
		title: post.title,
		description: post.description,
		index: false,
	});
}

export default async function BlogArticlePage({ params }: { params: Promise<BlogPageParams> }) {
	const { path } = await params;
	const post = getBlogPostBySlug(normalizePath(path), await getLocale());
	if (!post) notFound();

	return (
		<PublicPageShell title={post.title} description={post.description}>
			<article>
				<p className="max-w-3xl mb-7 text-sm text-violet-300 mx-auto">
					{new Intl.DateTimeFormat(post.locale, { dateStyle: "long" }).format(
						new Date(`${post.publishedAt}T00:00:00.000Z`),
					)}
				</p>
				<PublicMarkdown body={post.body} />
			</article>
		</PublicPageShell>
	);
}

function normalizePath(path: string | string[]): string {
	return Array.isArray(path) ? path.join("/") : path;
}
