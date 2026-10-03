import { useTranslations } from "next-intl";
import Image from "next/image";
import Link from "next/link";

import { blogPath, type BlogCardContent } from "../lib/blog-types";

export type BlogCardData = BlogCardContent & { comparisonInput?: BlogCardContent["cover"] };

export function BlogCard({
	post,
	category,
	readingTime,
	level = "h2",
	featured = false,
}: {
	post: BlogCardData;
	category: string;
	readingTime: string;
	level?: "h2" | "h3";
	featured?: boolean;
}) {
	const t = useTranslations();
	const Heading = level;
	return (
		<article
			className={`blog-card${post.cover ? " blog-card-with-cover" : " blog-card-text"}${featured ? " blog-card-featured" : ""}`}
		>
			{post.cover && (
				<Link
					href={blogPath(post)}
					prefetch={false}
					tabIndex={-1}
					className={`blog-card-image${post.comparisonInput ? " blog-card-comparison" : ""}`}
				>
					{post.comparisonInput && (
						<div className="blog-card-frame">
							<Image
								src={post.comparisonInput.src}
								alt={post.comparisonInput.alt}
								width={post.comparisonInput.width}
								height={post.comparisonInput.height}
								loading={featured ? "eager" : "lazy"}
								sizes="(max-width: 639px) 50vw, 28vw"
							/>
							<span>{t("effects.before")}</span>
						</div>
					)}
					<div className="blog-card-frame">
						<Image
							src={post.cover.src}
							alt={post.cover.alt}
							width={post.cover.width}
							height={post.cover.height}
							loading={featured ? "eager" : "lazy"}
							sizes={
								post.comparisonInput
									? "(max-width: 639px) 50vw, 28vw"
									: "(max-width: 639px) 100vw, 50vw"
							}
						/>
						{post.comparisonInput && <span>{t("effects.after")}</span>}
					</div>
				</Link>
			)}
			<div className="blog-card-body">
				<span className="blog-category">{category}</span>
				<Heading>
					<Link href={blogPath(post)} prefetch={false}>
						{post.title}
						<span className="blog-card-arrow" aria-hidden="true">
							{" "}
							↗
						</span>
					</Link>
				</Heading>
				<p>{post.description}</p>
				<div className="blog-card-meta">
					<time dateTime={post.date}>{post.dateLabel}</time>
					<span>{readingTime}</span>
				</div>
			</div>
		</article>
	);
}
