import { getBaseUrl } from "@shared/lib/base-url";
import { getLocale, getTranslations } from "next-intl/server";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { EffectExample } from "../../../../modules/effects/components/EffectExample";
import { getPublishedEffectById } from "../../../../modules/effects/lib/content";
import { effectPath } from "../../../../modules/effects/lib/types";
import { BlogAnalytics } from "../../../../modules/public-content/components/BlogAnalytics";
import { BlogCard } from "../../../../modules/public-content/components/BlogCard";
import { BlogEffectFeature } from "../../../../modules/public-content/components/BlogEffectFeature";
import { BlogPresetPrompt } from "../../../../modules/public-content/components/BlogPresetPrompt";
import { BlogPrompt } from "../../../../modules/public-content/components/BlogPrompt";
import {
	getBlogVisual,
	toVisualBlogCard,
	withBlogVisualCover,
} from "../../../../modules/public-content/components/BlogVisual.server";
import { ContentToc } from "../../../../modules/public-content/components/ContentToc";
import { EffectCallout } from "../../../../modules/public-content/components/EffectCallout";
import type { PhotoIdeaSearchParams } from "../../../../modules/public-content/components/PhotoIdeaArticle";
import { PublicMarkdown } from "../../../../modules/public-content/components/PublicMarkdown";
import { PublicPageShell } from "../../../../modules/public-content/components/PublicPageShell";
import {
	getContentHeadings,
	getReadingMinutes,
} from "../../../../modules/public-content/lib/blog-markdown";
import {
	blogStructuredData,
	formatBlogDate,
	serializeBlogJsonLd,
} from "../../../../modules/public-content/lib/blog-presentation";
import { BLOG_EDITORIAL_TEAM, blogPath } from "../../../../modules/public-content/lib/blog-types";
import {
	getBlogPostBySlug,
	getPublishedBlogPostPaths,
	getRelatedBlogPosts,
} from "../../../../modules/public-content/lib/content";
import { createPublicPageMetadata } from "../../../../modules/public-content/lib/metadata";

import "../../../../modules/public-content/components/blog.css";

type BlogPageParams = { path: string | string[] };

export function generateStaticParams() {
	return getPublishedBlogPostPaths().map((path) => ({ path: path.split("/") }));
}

export async function generateMetadata({ params }: { params: Promise<BlogPageParams> }) {
	const { path } = await params;
	const post = getBlogPostBySlug(normalizePath(path), await getLocale());
	if (!post) notFound();
	const cover = withBlogVisualCover(post).cover;
	const metadata = createPublicPageMetadata({
		path: blogPath(post),
		title: post.title,
		description: post.description,
		index: true,
	});
	return {
		...metadata,
		openGraph: {
			...metadata.openGraph,
			type: "article" as const,
			publishedTime: post.publishedAt,
			...(post.updatedAt ? { modifiedTime: post.updatedAt } : {}),
			authors: [BLOG_EDITORIAL_TEAM.name],
			...(cover
				? {
						images: [
							{
								url: new URL(cover.src, getBaseUrl()).href,
								width: cover.width,
								height: cover.height,
								alt: cover.alt,
							},
						],
					}
				: {}),
		},
		...(cover
			? { twitter: { ...metadata.twitter, images: [new URL(cover.src, getBaseUrl()).href] } }
			: {}),
	};
}

export default async function BlogArticlePage({
	params,
	searchParams = Promise.resolve({}),
}: {
	params: Promise<BlogPageParams>;
	searchParams?: Promise<PhotoIdeaSearchParams>;
}) {
	const { path } = await params;
	const locale = await getLocale();
	const t = await getTranslations();
	const post = getBlogPostBySlug(normalizePath(path), locale);
	if (!post) notFound();
	if (post.recipeId) {
		const recipe = getPublishedEffectById(post.recipeId);
		if (!recipe) notFound();
		const { PhotoIdeaArticle } =
			await import("../../../../modules/public-content/components/PhotoIdeaArticle");
		return <PhotoIdeaArticle post={post} recipe={recipe} searchParams={searchParams} />;
	}
	const visual = getBlogVisual(post);
	const visualPost = withBlogVisualCover(post);
	const headings = getContentHeadings(post.body);
	const analyticsPost = { id: post.id, slug: post.slug, published: true };
	const effects = post.relatedEffectIds
		.map(getPublishedEffectById)
		.filter((effect) => effect !== null);
	const relatedPosts = getRelatedBlogPosts(post, locale);
	const afterSections: Record<string, ReactNode[]> = {};
	for (const [index, block] of (post.contentBlocks ?? []).entries()) {
		const effect = effects.find((candidate) => candidate.id === block.effectId);
		if (!effect) continue;
		if (block.type === "before-after") {
			const example = effect.examples.find((candidate) => candidate.id === block.exampleId);
			if (example)
				(afterSections[block.afterHeadingId] ??= []).push(
					<EffectExample key={index} example={example} />,
				);
			continue;
		}
		if (!effect.presets.some((preset) => preset.id === block.presetId)) continue;
		const component =
			block.type === "preset-prompt" ? (
				<BlogPresetPrompt
					key={index}
					post={analyticsPost}
					effect={effect}
					presetId={block.presetId}
				/>
			) : (
				<BlogEffectFeature
					key={index}
					post={analyticsPost}
					effect={effect}
					presetId={block.presetId}
					showExample={
						!post.contentBlocks?.some(
							(other) =>
								other.type === "before-after" &&
								other.effectId === block.effectId &&
								other.afterHeadingId === block.afterHeadingId,
						)
					}
					showPrompt={
						!post.contentBlocks?.some(
							(other) =>
								other.type === "preset-prompt" &&
								other.effectId === block.effectId &&
								other.presetId === block.presetId &&
								other.afterHeadingId === block.afterHeadingId,
						)
					}
				/>
			);
		(afterSections[block.afterHeadingId] ??= []).push(component);
	}
	const primaryEffect =
		!post.contentBlocks?.length && effects.find((effect) => effect.id === post.primaryEffectId);
	const breadcrumb = (
		<nav className="blog-breadcrumb" aria-label={t("guides.breadcrumbLabel")}>
			<ol>
				<li>
					<Link href="/">{t("guides.home")}</Link>
				</li>
				<li aria-hidden="true">/</li>
				<li>
					<Link href="/blog">{t("guides.breadcrumb")}</Link>
				</li>
				<li aria-hidden="true">/</li>
				<li aria-current="page">{post.title}</li>
			</ol>
		</nav>
	);
	return (
		<PublicPageShell
			compact
			title={post.title}
			description={post.description}
			eyebrow={
				<>
					{breadcrumb}
					<p className="blog-category">{t(`guides.types.${post.articleType}`)}</p>
				</>
			}
			headingMeta={
				<div className="blog-article-meta">
					<span>
						{t("guides.by")} {BLOG_EDITORIAL_TEAM.name}
					</span>
					<span>
						{t("guides.published")}{" "}
						<time dateTime={post.publishedAt}>{formatBlogDate(post.publishedAt, locale)}</time>
					</span>
					{post.updatedAt && post.updatedAt !== post.publishedAt && (
						<span>
							{t("guides.updated")}{" "}
							<time dateTime={post.updatedAt}>{formatBlogDate(post.updatedAt, locale)}</time>
						</span>
					)}
					<span>{t("guides.readingTime", { minutes: getReadingMinutes(post.body) })}</span>
				</div>
			}
		>
			<BlogAnalytics post={analyticsPost} />
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: serializeBlogJsonLd(
						blogStructuredData(visualPost, getBaseUrl(), {
							home: t("guides.home"),
							blog: t("guides.breadcrumb"),
						}),
					),
				}}
			/>
			<div className="blog-layout">
				<aside className="blog-toc-aside">
					<ContentToc headings={headings} title={t("guides.onThisPage")} />
				</aside>
				<article className="blog-prose">
					{visualPost.cover && (
						<figure className="blog-cover">
							<Image
								src={visualPost.cover.src}
								alt={visualPost.cover.alt}
								width={visualPost.cover.width}
								height={visualPost.cover.height}
								sizes="(max-width: 767px) 100vw, 736px"
							/>
							{visual && !post.cover && (
								<figcaption>
									<span>
										{t("effects.example")} · {visual.preset.name}
									</span>
									<Link href={effectPath(visual.effect, visual.preset.id, post.id)}>
										{t("guides.usePreset")}
										<span aria-hidden="true"> →</span>
									</Link>
								</figcaption>
							)}
						</figure>
					)}
					<ContentToc headings={headings} title={t("guides.onThisPage")} mobile />
					<PublicMarkdown
						body={post.body}
						afterSections={afterSections}
						copyQuotedPrompts={post.articleType === "prompt-guides"}
						renderPrompt={(prompt, key) => (
							<BlogPrompt key={key} post={analyticsPost} prompt={prompt} />
						)}
					/>
					{Boolean(post.tests?.length) && (
						<section className="blog-tests">
							<h2>{t("guides.testContext")}</h2>
							<ul>
								{post.tests!.map((test, index) => (
									<li key={index}>
										<p>
											{t("guides.testedOn")}{" "}
											<time dateTime={test.testedAt}>{formatBlogDate(test.testedAt, locale)}</time>
										</p>
										<p>{test.context}</p>
										<p>{test.result}</p>
									</li>
								))}
							</ul>
						</section>
					)}
					{Boolean(post.sources?.length) && (
						<section className="blog-sources">
							<h2>{t("guides.sources")}</h2>
							<ul>
								{post.sources!.map((source) => (
									<li key={source.url}>
										<a href={source.url} rel="noreferrer">
											{source.title}
										</a>
									</li>
								))}
							</ul>
						</section>
					)}
					<footer className="blog-author">
						<p>{BLOG_EDITORIAL_TEAM.name}</p>
						<p>{t("guides.authorAbout")}</p>
					</footer>
				</article>
				<aside className="blog-cta-aside">
					{primaryEffect && (
						<div>
							<EffectCallout
								effect={primaryEffect}
								sourceBlogId={post.id}
								label={t("guides.useEffect")}
								compact
							/>
						</div>
					)}
				</aside>
			</div>
			{effects.length > 0 && (
				<section className="blog-related">
					<h2>{t("guides.relatedEffects")}</h2>
					{effects.map((effect) => (
						<EffectCallout
							key={effect.id}
							effect={effect}
							sourceBlogId={post.id}
							label={t("guides.useEffect")}
						/>
					))}
				</section>
			)}
			{relatedPosts.length > 0 && (
				<section className="blog-related">
					<h2>{t("guides.relatedArticles")}</h2>
					<div className="blog-grid">
						{relatedPosts.map((related) => (
							<BlogCard
								key={related.id}
								post={toVisualBlogCard(related, locale)}
								category={t(`guides.categories.${related.categoryId}`)}
								readingTime={t("guides.readingTime", { minutes: getReadingMinutes(related.body) })}
								level="h3"
							/>
						))}
					</div>
				</section>
			)}
		</PublicPageShell>
	);
}

function normalizePath(path: string | string[]): string {
	return Array.isArray(path) ? path.join("/") : path;
}
