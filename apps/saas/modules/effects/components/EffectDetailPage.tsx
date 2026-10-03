import { getSession } from "@auth/lib/server";
import {
	RegisteredEditor,
	type CreatePageFilters,
} from "@media/components/editor/RegisteredEditor";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { MainAccountBoundary } from "@shared/components/MainAccountBoundary";
import { RegisteredWorkspaceBoundary } from "@shared/components/RegisteredWorkspaceBoundary";
import { StudioShell } from "@shared/components/studio/StudioShell";
import { getBaseUrl } from "@shared/lib/base-url";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { Suspense } from "react";

import { LandingGenerator } from "../../landing/components/LandingGenerator";
import { PublicFooterLinks } from "../../public-content/components/PublicFooterLinks";
import { getBlogPostsForEffect } from "../../public-content/lib/content";
import { getRelatedEffects } from "../lib/content";
import { effectPath, resolveEffectPreset, type EffectPageContent } from "../lib/types";
import { EffectAnalytics } from "./EffectAnalytics";
import { EffectControls, EffectExampleStage } from "./EffectControls";
import { EffectEditorProvider } from "./EffectEditorProvider";
import { EffectExample } from "./EffectExample";
import { EffectPresetCard } from "./EffectPresetCard";
import { EffectRecommendations } from "./EffectRecommendations";

import "../effects.css";

export async function EffectDetailPage({
	effect,
	presetId,
	sourceBlogId,
	searchParams,
	preview = false,
	internalSource,
}: {
	effect: EffectPageContent;
	presetId?: string;
	sourceBlogId?: string;
	searchParams: Promise<CreatePageFilters>;
	preview?: boolean;
	internalSource?: "effects-directory" | "home" | "image-to-image" | "model" | "effect";
}) {
	const [t, locale] = await Promise.all([getTranslations("effects"), getLocale()]);
	const preset = resolveEffectPreset(effect, presetId);
	const presetExampleIds = new Set(
		effect.presets.map(
			(item) =>
				effect.examples.find(
					(candidate) =>
						item.exampleIds.includes(candidate.id) &&
						candidate.presetId === item.id &&
						candidate.presetVersion === item.version,
				)?.id,
		),
	);
	const additionalExamples = effect.examples.filter((example) => !presetExampleIds.has(example.id));
	const posts = getBlogPostsForEffect(effect.id, locale);
	const allowedSourceBlogIds = posts.map((post) => post.id);
	const source =
		sourceBlogId && allowedSourceBlogIds.includes(sourceBlogId) ? sourceBlogId : undefined;
	const canonical = new URL(effectPath(effect), getBaseUrl()).href;
	const structuredData = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebPage",
				name: effect.title,
				description: effect.summary,
				url: canonical,
				inLanguage: "en",
				dateModified: effect.updatedAt,
				...(effect.cover ? { image: new URL(effect.cover.src, getBaseUrl()).href } : {}),
			},
			{
				"@type": "BreadcrumbList",
				itemListElement: [
					{ "@type": "ListItem", position: 1, name: "EzImageAI", item: getBaseUrl() },
					{
						"@type": "ListItem",
						position: 2,
						name: "AI Effects",
						item: new URL("/effects", getBaseUrl()).href,
					},
					{ "@type": "ListItem", position: 3, name: effect.title, item: canonical },
				],
			},
		],
	};
	return (
		<StudioShell>
			<main className="effects-page">
				{!preview && (
					<script
						type="application/ld+json"
						dangerouslySetInnerHTML={{
							__html: JSON.stringify(structuredData).replaceAll("<", "\\u003c"),
						}}
					/>
				)}
				<header className="effects-intro container">
					<nav className="effects-breadcrumb" aria-label={t("breadcrumb")}>
						<Link href="/">{t("home")}</Link>
						<span aria-hidden="true">/</span>
						<Link href="/effects">{t("name")}</Link>
						<span aria-hidden="true">/</span>
						<span>{t(`categories.${effect.primaryCategoryId}`)}</span>
					</nav>
					{preview && (
						<div className="effect-preview-notice" role="note">
							{t("previewNotice")}
						</div>
					)}
					<h1>{effect.title}</h1>
					<p>{effect.summary}</p>
					<div className="effect-actions effect-intro-actions">
						<a className="effect-button" href="#effect-presets">
							{t("copyAPrompt")}
						</a>
						<a className="effect-button is-secondary" href="#image-editor">
							{t("tryWithPhoto")}
						</a>
					</div>
				</header>
				<EffectEditorProvider
					effect={effect}
					initialPresetId={preset.id}
					preview={preview}
					sourceBlogId={source}
					allowedSourceBlogIds={allowedSourceBlogIds}
					internalSource={source ? "blog" : internalSource}
				>
					<EffectAnalytics
						effect={effect}
						initialPresetId={preset.id}
						preview={preview}
						sourceBlogId={source}
						allowedSourceBlogIds={allowedSourceBlogIds}
						internalSource={source ? "blog" : internalSource}
					/>
					<div className="container">
						<EffectExampleStage mobile />
						<section className="effect-workbench" id="image-editor" aria-label={t("workspace")}>
							<div className="effect-workbench-controls">
								<EffectControls />
								<Suspense fallback={<output className="mt-5 block">{t("loadingEditor")}</output>}>
									<EffectGenerationWorkspace searchParams={searchParams} />
								</Suspense>
							</div>
							<EffectExampleStage />
						</section>
						<section className="effect-content-section" aria-labelledby="effect-presets">
							<h2 id="effect-presets">{t("presetsTitle")}</h2>
							<p>{t("presetsDescription")}</p>
							{effect.examples.length > 0 && (
								<p className="effect-examples-notice">{t("examplesNotice")}</p>
							)}
							<div className="effect-preset-grid">
								{effect.presets.map((item) => (
									<EffectPresetCard
										key={item.id}
										preset={item}
										examples={effect.examples}
										limitation={effect.limitations[0]}
									/>
								))}
							</div>
						</section>
					</div>
				</EffectEditorProvider>
				<div className="container">
					<section className="effect-content-section" aria-labelledby="effect-how">
						<h2 id="effect-how">{t("howTitle")}</h2>
						<ol className="effect-steps">
							{effect.instructions.map((step) => (
								<li key={step.title}>
									<h3>{step.title}</h3>
									<p>{step.body}</p>
								</li>
							))}
						</ol>
					</section>
					<section className="effect-content-section" aria-labelledby="effect-limits">
						<h2 id="effect-limits">{t("limitations")}</h2>
						<ul className="effect-limitations">
							{effect.limitations.map((limit) => (
								<li key={limit}>{limit}</li>
							))}
						</ul>
					</section>
					{additionalExamples.length > 0 && (
						<section className="effect-content-section" aria-labelledby="effect-results">
							<h2 id="effect-results">{t("testedExamples")}</h2>
							<p>{t("examplesNotice")}</p>
							<div className="effect-preset-grid">
								{additionalExamples.map((example) => (
									<EffectExample key={example.id} example={example} />
								))}
							</div>
						</section>
					)}
					<section className="effect-content-section effect-faq" aria-labelledby="effect-faq">
						<h2 id="effect-faq">{t("faq")}</h2>
						{effect.faq.map((faq) => (
							<details key={faq.question}>
								<summary>{faq.question}</summary>
								<p>{faq.answer}</p>
							</details>
						))}
					</section>
					{posts.length > 0 && (
						<section className="effect-content-section" aria-labelledby="effect-guides">
							<h2 id="effect-guides">{t("relatedGuides")}</h2>
							<div className="effect-guide-links">
								{posts.map((post) => (
									<Link key={post.id} href={`/blog/${post.slug}`}>
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
				<EffectRecommendations effects={getRelatedEffects(effect)} />
				<footer className="border-white/10 py-8 border-t">
					<PublicFooterLinks className="gap-x-5 gap-y-3 text-sm text-slate-400 container flex flex-wrap" />
				</footer>
			</main>
		</StudioShell>
	);
}

async function EffectGenerationWorkspace({
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
