import { getLocale, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { getPublishedEffects } from "../../../modules/effects/lib/content";
import { BlogDirectory } from "../../../modules/public-content/components/BlogDirectory";
import { toVisualBlogCard } from "../../../modules/public-content/components/BlogVisual.server";
import { EffectCallout } from "../../../modules/public-content/components/EffectCallout";
import { PublicPageShell } from "../../../modules/public-content/components/PublicPageShell";
import { getAllPublishedBlogPosts } from "../../../modules/public-content/lib/content";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";
import { contentPagePath, paginateContent } from "../../../modules/public-content/lib/pagination";

import "../../../modules/public-content/components/blog.css";

type BlogIndexProps = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata(props: BlogIndexProps) {
	const { searchParams } = props ?? {};
	const t = await getTranslations();
	const query = (await searchParams) ?? {};
	const page = paginateContent(getAllPublishedBlogPosts(await getLocale()), query.page);
	if (!page) notFound();
	return createPublicPageMetadata({
		path: contentPagePath("/blog", page.page),
		title:
			page.page > 1
				? `${t("guides.title")} — ${t("guides.pageNumber", { page: page.page })}`
				: t("guides.title"),
		description: t("guides.description"),
		index: !query.q && !query.category && !query.tag,
	});
}

export default async function BlogPage(props: BlogIndexProps) {
	const { searchParams } = props ?? {};
	const locale = await getLocale();
	const t = await getTranslations();
	const posts = getAllPublishedBlogPosts(locale);
	const query = (await searchParams) ?? {};
	const pagination = paginateContent(posts, query.page);
	if (!pagination) notFound();
	const relatedIds = new Set(posts.flatMap((post) => post.relatedEffectIds));
	const effects = getPublishedEffects()
		.filter((effect) => relatedIds.has(effect.id))
		.slice(0, 3);
	return (
		<PublicPageShell title={t("guides.title")} description={t("guides.description")} compact>
			<BlogDirectory
				posts={posts.map((post) => toVisualBlogCard(post, locale))}
				page={pagination.page}
			/>
			{effects.length > 0 && (
				<section className="blog-related">
					<h2>{t("guides.relatedEffects")}</h2>
					{effects.map((effect) => (
						<EffectCallout key={effect.id} effect={effect} label={t("guides.useEffect")} />
					))}
				</section>
			)}
		</PublicPageShell>
	);
}
