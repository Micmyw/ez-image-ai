import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";

import { getFeaturedPhotoIdeas, getPhotoIdeasForProduct } from "../lib/content";
import { BlogCard } from "./BlogCard";
import { toVisualBlogCard } from "./BlogVisual.server";

import "./blog-card.css";
import "./photo-idea-recommendations.css";

/** Editorial discovery uses the same published Blog records as the Blog directory. */
export function PhotoIdeaRecommendations({
	productKey,
	featured = false,
}: {
	productKey?: string;
	featured?: boolean;
}) {
	const locale = useLocale();
	const t = useTranslations("guides");
	const posts = productKey
		? getPhotoIdeasForProduct(productKey, locale).slice(0, 3)
		: getFeaturedPhotoIdeas(locale, featured ? 4 : 3);
	if (!posts.length) return null;
	return (
		<section className="photo-idea-recommendations container" data-photo-ideas-recommendations="">
			<div className="photo-idea-recommendations-heading">
				<h2>{t("photoIdeas.recommended")}</h2>
				<Link href="/blog?category=photo-ideas">
					{t("photoIdeas.explore")} <span aria-hidden="true">↗</span>
				</Link>
			</div>
			<div className={posts.length === 1 ? "photo-idea-recommendations-single" : "blog-grid"}>
				{posts.map((post) => {
					const card = toVisualBlogCard(post, locale);
					return (
						<BlogCard
							key={post.id}
							post={card}
							category={t(`categories.${post.categoryId}`)}
							readingTime={t("readingTime", { minutes: card.readingMinutes })}
							level="h3"
							featured={featured && posts.length === 1}
						/>
					);
				})}
			</div>
		</section>
	);
}
