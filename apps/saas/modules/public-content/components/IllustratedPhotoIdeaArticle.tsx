import { getSession } from "@auth/lib/server";
import { RegisteredEditor } from "@media/components/editor/RegisteredEditor";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { MainAccountBoundary } from "@shared/components/MainAccountBoundary";
import { RegisteredWorkspaceBoundary } from "@shared/components/RegisteredWorkspaceBoundary";
import { getBaseUrl } from "@shared/lib/base-url";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Suspense } from "react";

import { EffectExampleStage, EffectPresetPrompt } from "../../effects/components/EffectControls";
import { EffectEditorProvider } from "../../effects/components/EffectEditorProvider";
import { IllustratedPresetPicker } from "../../effects/components/IllustratedPresetPicker";
import { resolveEffectPreset, type EffectPageContent } from "../../effects/lib/types";
import { LandingGenerator } from "../../landing/components/LandingGenerator";
import { blogStructuredData, serializeBlogJsonLd } from "../lib/blog-presentation";
import type { BlogPost } from "../lib/blog-types";
import { BlogAnalytics } from "./BlogAnalytics";
import type { PhotoIdeaSearchParams } from "./PhotoIdeaArticle";
import { PublicMarkdown } from "./PublicMarkdown";
import { PublicPageShell } from "./PublicPageShell";

import "../../effects/effects.css";
import "./illustrated-photo-idea.css";

export async function IllustratedPhotoIdeaArticle({
	post,
	recipe,
	searchParams,
}: {
	post: BlogPost;
	recipe: EffectPageContent;
	searchParams: Promise<PhotoIdeaSearchParams>;
}) {
	const [t, query] = await Promise.all([getTranslations(), searchParams]);
	const preset = resolveEffectPreset(
		recipe,
		typeof query.preset === "string" ? query.preset : undefined,
	);
	return (
		<PublicPageShell
			compact
			title={recipe.title}
			description={post.description}
			eyebrow={
				<nav aria-label={t("guides.breadcrumbLabel")} className="illustrated-breadcrumb">
					<Link href="/blog">{t("guides.breadcrumb")}</Link>
					<span aria-hidden="true">/</span>
					<Link href="/blog?category=photo-ideas">{t("guides.categories.photo-ideas")}</Link>
				</nav>
			}
		>
			<BlogAnalytics post={{ id: post.id, slug: post.slug, published: true }} />
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: serializeBlogJsonLd(
						blogStructuredData(post, getBaseUrl(), {
							home: t("guides.home"),
							blog: t("guides.breadcrumb"),
						}),
					),
				}}
			/>
			<EffectEditorProvider
				effect={recipe}
				initialPresetId={preset.id}
				sourceBlogId={post.id}
				allowedSourceBlogIds={[post.id]}
				internalSource="blog"
			>
				<div className="illustrated-photo-idea effects-page">
					<section
						className="illustrated-workbench studio-theme"
						id="image-editor"
						aria-label={t("effects.workspace")}
					>
						<div className="illustrated-workbench-controls">
							<IllustratedPresetPicker />
							<Suspense fallback={<output>{t("effects.loadingEditor")}</output>}>
								<IllustratedWorkspace searchParams={searchParams} />
							</Suspense>
						</div>
						<EffectExampleStage />
					</section>
					<div className="illustrated-instructions">
						{recipe.instructions.map((step, index) => (
							<div key={step.title}>
								<span aria-hidden="true">{index + 1}</span>
								<h2>{step.title}</h2>
								<p>{step.body}</p>
							</div>
						))}
					</div>
					<div className="illustrated-guide">
						<PublicMarkdown
							body={post.body}
							allowedExternalUrls={post.sources?.map((source) => source.url)}
						/>
						<section className="illustrated-prompts" aria-labelledby="sheru-prompts">
							<h2 id="sheru-prompts">{t("effects.fullPrompt")}</h2>
							{recipe.presets.map((item) => (
								<div key={item.id} id={`preset-${item.id}`}>
									<h3>{item.name}</h3>
									<EffectPresetPrompt presetId={item.id} />
								</div>
							))}
						</section>
						<section className="effect-faq" aria-labelledby="sheru-faq">
							<h2 id="sheru-faq">{t("guides.photoIdeas.faqTitle")}</h2>
							{recipe.faq.map((item) => (
								<details key={item.question}>
									<summary>{item.question}</summary>
									<p>{item.answer}</p>
								</details>
							))}
						</section>
					</div>
				</div>
			</EffectEditorProvider>
		</PublicPageShell>
	);
}

async function IllustratedWorkspace({
	searchParams,
}: {
	searchParams: Promise<PhotoIdeaSearchParams>;
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
