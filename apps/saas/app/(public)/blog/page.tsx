import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

import { PublicPageShell } from "../../../modules/public-content/components/PublicPageShell";
import { getAllPublishedBlogPosts } from "../../../modules/public-content/lib/content";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export async function generateMetadata() {
	const t = await getTranslations();
	return createPublicPageMetadata({
		path: "/blog",
		title: t("blog.title"),
		description: t("blog.description"),
		index: false,
	});
}

export default async function BlogPage() {
	const locale = await getLocale();
	const t = await getTranslations();
	const posts = getAllPublishedBlogPosts(locale);

	return (
		<PublicPageShell title={t("blog.title")} description={t("blog.description")}>
			<div className="max-w-3xl gap-5 mx-auto grid">
				{posts.map((post) => (
					<article
						key={post.slug}
						className="border-white/10 bg-white/[0.045] p-6 rounded-3xl border"
					>
						<p className="text-xs font-semibold text-violet-300 tracking-wide uppercase">
							{new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
								new Date(`${post.publishedAt}T00:00:00.000Z`),
							)}
						</p>
						<h2 className="mt-3 text-2xl font-semibold text-white">
							<Link className="hover:text-violet-200" href={`/blog/${post.slug}`}>
								{post.title}
							</Link>
						</h2>
						<p className="mt-3 leading-7 text-slate-300">{post.description}</p>
						<div className="mt-4 gap-2 flex flex-wrap">
							{post.tags.map((tag) => (
								<span key={tag} className="text-xs text-slate-400">
									#{tag}
								</span>
							))}
						</div>
					</article>
				))}
			</div>
		</PublicPageShell>
	);
}
