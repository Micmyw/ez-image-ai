import { getSession } from "@auth/lib/server";
import {
	RegisteredEditor,
	type CreatePageFilters,
} from "@media/components/editor/RegisteredEditor";
import { ToolPromptProvider } from "@media/lib/tool-prompt-context";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { MainAccountBoundary } from "@shared/components/MainAccountBoundary";
import { RegisteredWorkspaceBoundary } from "@shared/components/RegisteredWorkspaceBoundary";
import { StudioShell } from "@shared/components/studio/StudioShell";
import { getBaseUrl } from "@shared/lib/base-url";
import Link from "next/link";
import { Suspense } from "react";

import { LandingGenerator } from "../../landing/components/LandingGenerator";
import { InspirationPrompt } from "../../models/components/InspirationPrompt";
import { PublicFooterLinks } from "../../public-content/components/PublicFooterLinks";
import {
	IMAGE_TOOL_PAGES,
	imageToolStructuredData,
	type ImageToolPageKey,
} from "../lib/tool-pages";

import "../image-tools.css";

export function ImageToolPage({
	tool,
	searchParams = Promise.resolve({}),
}: {
	tool: ImageToolPageKey;
	searchParams?: Promise<CreatePageFilters>;
}) {
	const content = IMAGE_TOOL_PAGES[tool];
	return (
		<StudioShell>
			<ToolPromptProvider initialPrompt="">
				<main className="ai-tool-page" lang="en">
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
						<header className="ai-tool-hero">
							<p className="ai-tool-eyebrow">Create with GPT Image 2.6</p>
							<h1>{content.heading}</h1>
							<p className="ai-tool-intro">{content.intro}</p>
							<ul className="ai-tool-facts" aria-label="Tool features">
								{content.facts.map((fact) => (
									<li key={fact}>{fact}</li>
								))}
							</ul>
						</header>
						<section id="image-editor" className="ai-tool-workspace" aria-label={content.heading}>
							<Suspense fallback={<output aria-live="polite">Loading your workspace…</output>}>
								<ImageToolWorkspace searchParams={searchParams} />
							</Suspense>
						</section>
						<p className="ai-tool-settings-note">{content.settingsNote}</p>
						<p className="ai-tool-settings-note">
							<Link href="/image-pass" prefetch={false}>
								3 successful results for $2.99
							</Link>
							{
								": use new or remaining $2.99 pack passes for Flare, Sunburst, SVG or GIF. One successful result uses one pass, with no subscription required."
							}
						</p>
						<p className="ai-tool-settings-note">
							Generation is available only when the selected model is available in the editor. If it
							is unavailable, you can prepare a prompt and return later.
						</p>
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
						<section className="ai-tool-section" aria-labelledby="tool-prompts-title">
							<h2 id="tool-prompts-title">A starting point for your prompt</h2>
							<p className="ai-tool-section-intro">
								Adapt these prompt ideas to your own project. They are starting points, not verified
								output examples.
							</p>
							<div className="ai-tool-prompts">
								{content.prompts.map((example) => (
									<article key={example.title}>
										<h3>{example.title}</h3>
										<p>{example.prompt}</p>
										<InspirationPrompt prompt={example.prompt} />
									</article>
								))}
							</div>
						</section>
						<section className="ai-tool-section ai-tool-faq" aria-labelledby="tool-faq-title">
							<h2 id="tool-faq-title">{content.heading} FAQ</h2>
							{content.faq.map(({ question, answer }) => (
								<details key={question}>
									<summary>{question}</summary>
									<p>{answer}</p>
								</details>
							))}
						</section>
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
