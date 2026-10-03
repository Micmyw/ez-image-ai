import { getSession } from "@auth/lib/server";
import {
	RegisteredEditor,
	type CreatePageFilters,
} from "@media/components/editor/RegisteredEditor";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { MainAccountBoundary } from "@shared/components/MainAccountBoundary";
import { RegisteredWorkspaceBoundary } from "@shared/components/RegisteredWorkspaceBoundary";
import { getBaseUrl } from "@shared/lib/base-url";
import { getLocale, getTranslations } from "next-intl/server";
import Image from "next/image";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { EffectAnalytics } from "../../effects/components/EffectAnalytics";
import { EffectControls, EffectExampleStage } from "../../effects/components/EffectControls";
import { EffectEditorProvider } from "../../effects/components/EffectEditorProvider";
import { EffectPresetCard } from "../../effects/components/EffectPresetCard";
import { resolveEffectPreset, type EffectPageContent } from "../../effects/lib/types";
import { LandingGenerator } from "../../landing/components/LandingGenerator";
import { getContentHeadings, getReadingMinutes } from "../lib/blog-markdown";
import { blogStructuredData, formatBlogDate, serializeBlogJsonLd } from "../lib/blog-presentation";
import { BLOG_EDITORIAL_TEAM, type BlogPost } from "../lib/blog-types";
import { getBlogPostsForEffect, getRelatedBlogPosts } from "../lib/content";
import { BlogAnalytics } from "./BlogAnalytics";
import { BlogCard } from "./BlogCard";
import { toVisualBlogCard, withBlogVisualCover } from "./BlogVisual.server";
import { ContentToc } from "./ContentToc";
import { PublicMarkdown } from "./PublicMarkdown";
import { PublicPageShell } from "./PublicPageShell";

import "../../effects/effects.css";
import "./blog.css";

export type PhotoIdeaSearchParams = CreatePageFilters & {
	preset?: string;
	source?: string;
	from?: string;
};

/** Blog owns the article. A recipe adds reviewed examples and the existing generation workflow. */
export async function PhotoIdeaArticle({
	post,
	recipe,
	searchParams,
	preview = false,
}: {
	post: BlogPost;
	recipe: EffectPageContent;
	searchParams: Promise<PhotoIdeaSearchParams>;
	preview?: boolean;
}) {
	const [t, locale, query] = await Promise.all([getTranslations(), getLocale(), searchParams]);
	const preset = resolveEffectPreset(
		recipe,
		typeof query.preset === "string" ? query.preset : undefined,
	);
	const posts = getBlogPostsForEffect(recipe.id, locale);
	const allowedSourceBlogIds = posts.map((entry) => entry.id);
	const sourceBlogId =
		typeof query.source === "string" && allowedSourceBlogIds.includes(query.source)
			? query.source
			: post.id;
	const relatedPosts = getRelatedBlogPosts(post, locale);
	const headings = getContentHeadings(post.body);
	const afterSections: Record<string, ReactNode[]> = {};
	const placement = post.recipePlacement;
	if (placement) {
		afterSections[placement.presetsAfterHeadingId] = [
			<section
				className="photo-idea-presets"
				key="presets"
				aria-label={t("guides.photoIdeas.presetsTitle")}
			>
				<p className="effect-examples-notice">{t("effects.examplesNotice")}</p>
				<div className="effect-preset-grid">
					{recipe.presets.map((item) => (
						<EffectPresetCard key={item.id} preset={item} examples={recipe.examples} />
					))}
				</div>
			</section>,
		];
		afterSections[placement.editorAfterHeadingId] = [
			<section
				className="photo-idea-generation studio-theme"
				key="editor"
				aria-labelledby="photo-idea-try"
			>
				<h3 id="photo-idea-try">{t("guides.photoIdeas.tryTitle")}</h3>
				<p>{t("guides.photoIdeas.tryDescription")}</p>
				<EffectExampleStage mobile />
				<div className="effect-workbench" id="image-editor" aria-label={t("effects.workspace")}>
					<div className="effect-workbench-controls">
						<EffectControls />
						<Suspense fallback={<output>{t("effects.loadingEditor")}</output>}>
							<PhotoIdeaGenerationWorkspace searchParams={searchParams} />
						</Suspense>
					</div>
					<EffectExampleStage />
				</div>
			</section>,
		];
	}
	return (
		<PublicPageShell
			compact
			title={post.title}
			description={post.description}
			eyebrow={
				<>
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
							<li>
								<Link href="/blog?category=photo-ideas">{t("guides.categories.photo-ideas")}</Link>
							</li>
						</ol>
					</nav>
					<p className="blog-category">{t("guides.types.photo-ideas")}</p>
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
			{preview ? (
				<div className="effect-preview-notice" role="note">
					{t("effects.previewNotice")}
				</div>
			) : (
				<>
					<BlogAnalytics post={{ id: post.id, slug: post.slug, published: true }} />
					<script
						type="application/ld+json"
						dangerouslySetInnerHTML={{
							__html: serializeBlogJsonLd(
								blogStructuredData(withBlogVisualCover(post), getBaseUrl(), {
									home: t("guides.home"),
									blog: t("guides.breadcrumb"),
								}),
							),
						}}
					/>
				</>
			)}
			<EffectEditorProvider
				effect={recipe}
				initialPresetId={preset.id}
				preview={preview}
				sourceBlogId={sourceBlogId}
				allowedSourceBlogIds={allowedSourceBlogIds}
				internalSource="blog"
			>
				<EffectAnalytics
					effect={recipe}
					initialPresetId={preset.id}
					preview={preview}
					sourceBlogId={sourceBlogId}
					allowedSourceBlogIds={allowedSourceBlogIds}
					internalSource="blog"
				/>
				<article className="photo-idea-article effects-page">
					<nav
						className="photo-idea-preview-strip"
						aria-label={t("guides.photoIdeas.presetsTitle")}
					>
						{recipe.presets.map((item) => {
							const example = recipe.examples.find(
								(candidate) =>
									item.exampleIds.includes(candidate.id) &&
									candidate.presetVersion === item.version &&
									candidate.presetId === item.id,
							);
							return example ? (
								<a key={item.id} href={`#preset-${item.id}`}>
									<Image
										src={example.output.src}
										alt={example.output.alt}
										width={example.output.width}
										height={example.output.height}
										sizes="(max-width: 767px) 33vw, 240px"
									/>
									<span>{item.name}</span>
								</a>
							) : null;
						})}
					</nav>
					<ContentToc headings={headings} title={t("guides.onThisPage")} mobile />
					<PublicMarkdown body={post.body} afterSections={afterSections} />
					<section
						className="effect-content-section photo-idea-notes"
						aria-labelledby="photo-idea-limits"
					>
						<h2 id="photo-idea-limits">{t("guides.photoIdeas.limitationsTitle")}</h2>
						<ul className="effect-limitations">
							{recipe.limitations.map((limit) => (
								<li key={limit}>{limit}</li>
							))}
						</ul>
					</section>
					<section
						className="effect-content-section effect-faq photo-idea-notes"
						aria-labelledby="photo-idea-faq"
					>
						<h2 id="photo-idea-faq">{t("guides.photoIdeas.faqTitle")}</h2>
						{recipe.faq.map((faq) => (
							<details key={faq.question}>
								<summary>{faq.question}</summary>
								<p>{faq.answer}</p>
							</details>
						))}
					</section>
					<footer className="blog-author photo-idea-notes">
						<p>{BLOG_EDITORIAL_TEAM.name}</p>
						<p>{t("guides.authorAbout")}</p>
					</footer>
				</article>
			</EffectEditorProvider>
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

async function PhotoIdeaGenerationWorkspace({
	searchParams,
}: {
	searchParams: Promise<CreatePageFilters>;
}) {
	const session = await getSession();
	return session && !isAnonymousUser(session.user) ? (
		<RegisteredWorkspaceBoundary>
			<MainAccountBoundary>
				<RegisteredEditor searchParams={searchParams} />
			</MainAccountBoundary>
		</RegisteredWorkspaceBoundary>
	) : (
		<LandingGenerator />
	);
}
