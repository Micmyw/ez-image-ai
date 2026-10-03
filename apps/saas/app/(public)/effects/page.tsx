import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EffectsDirectory } from "../../../modules/effects/components/EffectsDirectory";
import { getPublishedEffects } from "../../../modules/effects/lib/content";
import { PublicPageShell } from "../../../modules/public-content/components/PublicPageShell";
import { getAllPublishedBlogPosts } from "../../../modules/public-content/lib/content";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";
import { contentPagePath, paginateContent } from "../../../modules/public-content/lib/pagination";

import "../../../modules/effects/effects.css";

type Props = { searchParams?: Promise<{ page?: string | string[] }> };

export async function generateMetadata(props: Props) {
	const searchParams = await props?.searchParams;
	const page = paginateContent(getPublishedEffects(), searchParams?.page);
	if (!page) notFound();
	const t = await getTranslations("effects");
	return createPublicPageMetadata({
		path: contentPagePath("/effects", page.page),
		title: page.page === 1 ? t("title") : t("pageTitle", { page: page.page }),
		description: t("description"),
		index: page.totalItems > 0,
	});
}

export default async function EffectsPage(props: Props) {
	const searchParams = await props?.searchParams;
	const effects = getPublishedEffects();
	const page = paginateContent(effects, searchParams?.page);
	if (!page) notFound();
	const [t, locale] = await Promise.all([getTranslations("effects"), getLocale()]);
	const guides = getAllPublishedBlogPosts(locale)
		.filter((post) => post.articleType === "prompt-guides")
		.slice(0, 3);
	return (
		<PublicPageShell
			compact
			title={t("title")}
			description={t("description")}
			eyebrow={
				<Link href="/" className="hover:text-white">
					{t("home")} / {t("name")}
				</Link>
			}
		>
			<div className="effects-page">
				<EffectsDirectory effects={effects} page={page.page} />
				{guides.length > 0 && (
					<section className="effect-content-section" aria-labelledby="directory-guides">
						<h2 id="directory-guides">{t("relatedGuides")}</h2>
						<div className="effect-guide-links">
							{guides.map((post) => (
								<Link key={post.slug} href={`/blog/${post.slug}`}>
									<h3>
										{post.title} <span aria-hidden="true">↗</span>
									</h3>
									<p>{post.description}</p>
								</Link>
							))}
						</div>
					</section>
				)}
			</div>
		</PublicPageShell>
	);
}
