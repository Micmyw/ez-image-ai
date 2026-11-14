import { getSession } from "@auth/lib/server";
import {
	RegisteredEditor,
	type CreatePageFilters,
} from "@media/components/editor/RegisteredEditor";
import { ToolPromptProvider } from "@media/lib/tool-prompt-context";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { GlowSurface } from "@repo/ui/components/glow-surface";
import { MainAccountBoundary } from "@shared/components/MainAccountBoundary";
import { RegisteredWorkspaceBoundary } from "@shared/components/RegisteredWorkspaceBoundary";
import { StudioShell } from "@shared/components/studio/StudioShell";
import { getBaseUrl } from "@shared/lib/base-url";
import Link from "next/link";
import { Suspense, type ComponentProps } from "react";

import { LandingGenerator } from "../../landing/components/LandingGenerator";
import { InspirationPrompt } from "../../models/components/InspirationPrompt";
import { PublicFooterLinks } from "../../public-content/components/PublicFooterLinks";
import {
	IMAGE_TOOL_PAGES,
	imageToolStructuredData,
	type ImageToolPageKey,
} from "../lib/tool-pages";
import { GptImageShowcase } from "./GptImageShowcase";
import { MiniMaxShowcase } from "./MiniMaxShowcase";
import { ModelHero } from "./ModelHero";
import { SeedreamShowcase } from "./SeedreamShowcase";

import "../image-tools.css";

const modelHeroes: Partial<Record<ImageToolPageKey, ComponentProps<typeof ModelHero>["model"]>> = {
	"minimax-h3-image": "minimax",
	"seedream-5-5": "seedream",
	"gpt-image-2-6-flare": "gpt-flare",
	"gpt-image-2-6-sunburst": "gpt-sunburst",
};

export function ImageToolPage({
	tool,
	searchParams = Promise.resolve({}),
}: {
	tool: ImageToolPageKey;
	searchParams?: Promise<CreatePageFilters>;
}) {
	const content = IMAGE_TOOL_PAGES[tool];
	const isMiniMax = tool === "minimax-h3-image";
	const isSeedream = tool === "seedream-5-5";
	const heroModel = modelHeroes[tool];
	const hasShowcase = Boolean(heroModel);
	const hasPromptImages = content.prompts.some((example) => example.image);
	const workspace = (
		<section id="image-editor" className="ai-tool-workspace" aria-label={content.heading}>
			<Suspense fallback={<output aria-live="polite">Loading your workspace…</output>}>
				<ImageToolWorkspace searchParams={searchParams} />
			</Suspense>
		</section>
	);
	const relatedTools = (
		<nav className="ai-tool-related" aria-label="Image generation tools">
			{Object.values(IMAGE_TOOL_PAGES).map((page) => (
				<Link
					key={page.path}
					href={page.path}
					prefetch={false}
					aria-current={page.path === content.path ? "page" : undefined}
				>
					{page.heading}
				</Link>
			))}
		</nav>
	);
	return (
		<StudioShell>
			<ToolPromptProvider initialPrompt="">
				<main
					className={`ai-tool-page${hasShowcase ? " model-tool-page" : ""}${heroModel ? ` ${heroModel}-page` : ""}`}
					lang="en"
				>
					<script
						type="application/ld+json"
						dangerouslySetInnerHTML={{
							__html: JSON.stringify(imageToolStructuredData(content, getBaseUrl())).replaceAll(
								"<",
								"\\u003c",
							),
						}}
					/>
					<div className="ai-tool-container">
						{heroModel ? (
							<GlowSurface
								className={`model-stage ${heroModel}-stage`}
								tone={isMiniMax ? "violet" : "aurora"}
								intensity={isMiniMax ? "subtle" : "strong"}
								radius="0"
							>
								<ModelHero model={heroModel} intro={content.intro} facts={content.facts} />
								{workspace}
							</GlowSurface>
						) : (
							<>
								<header className="ai-tool-hero">
									<div>
										<p className="ai-tool-eyebrow">
											Create with {content.modelName ?? "GPT Image 2.6"}
										</p>
										<h1>{content.heading}</h1>
									</div>
									<div>
										<p className="ai-tool-intro">{content.intro}</p>
										<ul className="ai-tool-facts" aria-label="Tool features">
											{content.facts.map((fact) => (
												<li key={fact}>{fact}</li>
											))}
										</ul>
									</div>
								</header>
								{workspace}
							</>
						)}
						<p className="ai-tool-settings-note">{content.settingsNote}</p>
						{content.showPassOffer !== false && (
							<p className="ai-tool-settings-note">
								<Link href="/image-pass" prefetch={false}>
									3 successful results for $2.99
								</Link>
								{
									": use new or remaining $2.99 pack passes for Flare, Sunburst, SVG or GIF. One successful result uses one pass, with no subscription required."
								}
							</p>
						)}
						{content.showAvailabilityNote !== false && (
							<p className="ai-tool-settings-note">
								Generation is available only when the selected model is available in the editor. If
								it is unavailable, you can prepare a prompt and return later.
							</p>
						)}
						{isMiniMax ? (
							<MiniMaxShowcase />
						) : isSeedream ? (
							<SeedreamShowcase />
						) : heroModel === "gpt-flare" || heroModel === "gpt-sunburst" ? (
							<GptImageShowcase variant={heroModel === "gpt-flare" ? "flare" : "sunburst"} />
						) : (
							relatedTools
						)}
						{content.relatedPhotoIdeas && (
							<section className="ai-tool-section" aria-labelledby="related-photo-ideas-title">
								<h2 id="related-photo-ideas-title">Photo ideas to try</h2>
								{content.relatedPhotoIdeas.map((idea) => (
									<article key={idea.href} className="ai-tool-photo-idea">
										<h3>
											<Link href={idea.href} prefetch={false}>
												{idea.title}
											</Link>
										</h3>
										<p>{idea.description}</p>
										<nav className="ai-tool-related" aria-label={`${idea.title} presets`}>
											{idea.presets.map((preset) => (
												<Link key={preset.href} href={preset.href} prefetch={false}>
													{preset.label}
												</Link>
											))}
										</nav>
									</article>
								))}
							</section>
						)}
						<section className="ai-tool-section" aria-labelledby="tool-steps-title">
							<h2 id="tool-steps-title">From your idea to a download</h2>
							<ol className="ai-tool-steps">
								{content.steps.map((step, index) => (
									<li key={step.title}>
										<span className="ai-tool-step-number" aria-hidden="true">
											0{index + 1}
										</span>
										<h3>{step.title}</h3>
										<p>{step.body}</p>
									</li>
								))}
							</ol>
						</section>
						<div className="ai-tool-guides">
							{content.sections.map((section) => (
								<section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
									<h2 id={`${section.id}-title`}>{section.title}</h2>
									<p>{section.body}</p>
								</section>
							))}
						</div>
						{!hasShowcase && (
							<section className="ai-tool-section" aria-labelledby="tool-prompts-title">
								<h2 id="tool-prompts-title">
									{hasPromptImages ? "See what you can create" : "A starting point for your prompt"}
								</h2>
								<p className="ai-tool-section-intro">
									Adapt a prompt to your own project and try it in the workspace above.
								</p>
								<div
									className={`ai-tool-prompts${hasPromptImages ? " ai-tool-prompts-with-images" : ""}`}
								>
									{content.prompts.map((example) => (
										<article key={example.title}>
											{example.image && (
												<div className="ai-tool-example-images">
													{example.referenceImage && (
														<figure>
															<img
																src={example.referenceImage.src}
																alt={example.referenceImage.alt}
																width={example.referenceImage.width}
																height={example.referenceImage.height}
																loading="lazy"
																decoding="async"
															/>
															<figcaption>
																<span>Before</span>
																<a href={example.referenceImage.src} download>
																	Download reference ↓
																</a>
															</figcaption>
														</figure>
													)}
													<figure>
														<img
															src={example.image.src}
															alt={example.image.alt}
															width={example.image.width}
															height={example.image.height}
															loading="lazy"
															decoding="async"
														/>
														<figcaption>
															{example.referenceImage ? "After" : "Text to image"} ·{" "}
															{example.resolution}
														</figcaption>
													</figure>
												</div>
											)}
											<h3>{example.title}</h3>
											{example.image ? (
												<details className="ai-tool-example-prompt">
													<summary>View prompt</summary>
													<p>{example.prompt}</p>
												</details>
											) : (
												<p>{example.prompt}</p>
											)}
											<InspirationPrompt prompt={example.prompt} />
										</article>
									))}
								</div>
							</section>
						)}
						<section className="ai-tool-section ai-tool-faq" aria-labelledby="tool-faq-title">
							<h2 id="tool-faq-title">{content.heading} FAQ</h2>
							{content.faq.map(({ question, answer }) => (
								<details key={question}>
									<summary>{question}</summary>
									<p>{answer}</p>
								</details>
							))}
						</section>
						{hasShowcase && relatedTools}
						<footer className="ai-tool-footer">
							<Link href="/">EzImageAI</Link>
							<PublicFooterLinks />
						</footer>
					</div>
				</main>
			</ToolPromptProvider>
		</StudioShell>
	);
}

async function ImageToolWorkspace({ searchParams }: { searchParams: Promise<CreatePageFilters> }) {
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
