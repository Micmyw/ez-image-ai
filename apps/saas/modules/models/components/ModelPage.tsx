import { getSession } from "@auth/lib/server";
import {
	RegisteredEditor,
	type CreatePageFilters,
} from "@media/components/editor/RegisteredEditor";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { MainAccountBoundary } from "@shared/components/MainAccountBoundary";
import { RegisteredWorkspaceBoundary } from "@shared/components/RegisteredWorkspaceBoundary";
import { StudioShell } from "@shared/components/studio/StudioShell";
import Link from "next/link";
import { Suspense } from "react";

import { LandingGenerator } from "../../landing/components/LandingGenerator";
import { PublicFooterLinks } from "../../public-content/components/PublicFooterLinks";
import { INSPIRATION, MODEL_PAGES, modelPath, type ModelPageContent } from "../lib/model-pages";
import { InspirationPrompt } from "./InspirationPrompt";
import { ModelArtwork } from "./ModelArtwork";

import "../models.css";

export async function ModelPage({
	model,
	searchParams,
}: {
	model: ModelPageContent;
	searchParams: Promise<CreatePageFilters>;
}) {
	const session = await getSession();
	const registered = session && !isAnonymousUser(session.user);
	const example = INSPIRATION[model.exampleArtwork];
	const before = model.beforeArtwork;
	const related = [
		...MODEL_PAGES.filter((candidate) => candidate.family === model.family),
		...MODEL_PAGES.filter((candidate) => candidate.family !== model.family),
	]
		.filter((candidate) => candidate.key !== model.key)
		.slice(0, 3);
	return (
		<StudioShell>
			<main className="model-page">
				<section id="image-editor" className="model-hero">
					<nav aria-label="Breadcrumb" className="model-breadcrumb">
						<Link href="/models">AI models</Link>
						<span aria-hidden="true">/</span>
						<span>{model.name}</span>
					</nav>
					<p className="model-eyebrow">{model.family} · Create with EzPic</p>
					<h1>
						{model.name}
						<span>AI Image Generator</span>
					</h1>
					<p className="model-intro">{model.description}</p>
					<ul className="model-tags" aria-label="Creative directions">
						{model.tags.map((tag) => (
							<li key={tag}>{tag}</li>
						))}
					</ul>
					<div className="model-generator">
						<Suspense fallback={<p className="model-loading">Loading your workspace…</p>}>
							{registered ? (
								<RegisteredWorkspaceBoundary>
									<MainAccountBoundary>
										<RegisteredEditor searchParams={searchParams} />
									</MainAccountBoundary>
								</RegisteredWorkspaceBoundary>
							) : (
								<LandingGenerator />
							)}
						</Suspense>
					</div>
				</section>
				<section className="model-story" aria-labelledby="model-story-title">
					<figure className="model-artwork">
						<ModelArtwork artwork={model.artwork} sizes="(max-width: 760px) 100vw, 45vw" />
						<figcaption>
							<span className="model-artwork-label">Creative inspiration</span>
							<span>Original EzPic concept artwork</span>
						</figcaption>
					</figure>
					<div className="model-story-copy">
						<p className="model-eyebrow">Explore the possibilities</p>
						<h2 id="model-story-title">{model.lead}</h2>
						{model.features.map((feature) => (
							<div className="model-feature" key={feature.title}>
								<h3>{feature.title}</h3>
								<p>{feature.description}</p>
							</div>
						))}
					</div>
				</section>
				<section
					className={`model-prompt-section${before ? " model-prompt-comparison" : ""}`}
					aria-labelledby="model-prompt-title"
				>
					<div className="model-example-media">
						{before && (
							<figure>
								<ModelArtwork artwork={before} sizes="(max-width: 760px) 90vw, 42vw" />
								<figcaption>
									<span>Line art</span>
									<a href={`/images/models/${model.beforeArtwork}.webp`} download>
										Download line art <span aria-hidden="true">↓</span>
									</a>
								</figcaption>
							</figure>
						)}
						<figure>
							<ModelArtwork artwork={model.exampleArtwork} sizes="(max-width: 760px) 90vw, 42vw" />
							<figcaption>{before ? "Color study" : "Original EzPic concept"}</figcaption>
						</figure>
					</div>
					<div className="model-example-content">
						<div className="model-example-intro">
							<p className="model-eyebrow">A starting point, in your own words</p>
							<h2 id="model-prompt-title">{example.title}</h2>
							<p>{model.tip}</p>
							{before && (
								<p>Download the line art and add it as a reference to try a color edit.</p>
							)}
						</div>
						<div className="model-prompt-card">
							<p className="model-eyebrow">Reference prompt</p>
							<blockquote>{example.prompt}</blockquote>
							<InspirationPrompt prompt={example.prompt} />
						</div>
					</div>
					<p className="model-artwork-note">
						These original AI-generated concepts illustrate creative directions. They are not
						benchmarks or verified outputs from the named model. Results vary with your prompt,
						reference, and settings.
					</p>
				</section>
				<section className="model-gallery" aria-labelledby="model-gallery-title">
					<div className="model-section-heading">
						<div>
							<p className="model-eyebrow">More creative inspiration</p>
							<h2 id="model-gallery-title">More ideas to make your own</h2>
						</div>
					</div>
					<div className="model-gallery-grid">
						{model.galleryArtwork.map((artwork) => (
							<figure className="model-gallery-card" key={artwork}>
								<ModelArtwork
									artwork={artwork}
									sizes="(max-width: 760px) 90vw, (max-width: 1300px) 40vw, 490px"
								/>
								<figcaption>{INSPIRATION[artwork].title}</figcaption>
							</figure>
						))}
					</div>
				</section>
				<section className="model-faq" aria-labelledby="model-faq-title">
					<div>
						<p className="model-eyebrow">Before you create</p>
						<h2 id="model-faq-title">{model.name} FAQ</h2>
					</div>
					<div>
						<details open>
							<summary>Can I create an image without uploading a reference?</summary>
							<p>
								Yes. Describe the image you want and leave the reference empty to use text to image.
								Add a reference to switch to image to image. Sign in to review the quote and start a
								generation.
							</p>
						</details>
						<details>
							<summary>How do I choose the output settings and credits?</summary>
							<p>
								The workspace shows the currently available choices for {model.name}. Select your
								output settings and review the quoted credits before confirming. Availability can
								change; an unavailable model cannot be submitted.
							</p>
						</details>
						<details>
							<summary>What should I check in the result?</summary>
							<p>{model.review}</p>
						</details>
						<details>
							<summary>Can I continue working on a generated image?</summary>
							<p>
								Your results appear in your workspace and history. Use a generated image as a
								reference for a new edit, or reuse the prompt to explore another direction. Each new
								generation has its own credit quote.
							</p>
						</details>
					</div>
				</section>
				<section className="model-related" aria-labelledby="model-related-title">
					<div className="model-section-heading">
						<div>
							<p className="model-eyebrow">Keep exploring</p>
							<h2 id="model-related-title">Another model, another direction</h2>
						</div>
						<Link href="/models">
							View all models <span aria-hidden="true">↗</span>
						</Link>
					</div>
					<div className="model-related-grid">
						{related.map((candidate) => (
							<Link
								className="model-related-card"
								key={candidate.key}
								href={modelPath(candidate.key)}
							>
								<div>
									<span>{candidate.family}</span>
									<h3>
										{candidate.name} <span aria-hidden="true">↗</span>
									</h3>
									<p>{candidate.lead}</p>
								</div>
							</Link>
						))}
					</div>
				</section>
				<footer className="model-footer">
					<Link href="/">EzPic</Link>
					<PublicFooterLinks className="model-footer-links" />
				</footer>
			</main>
		</StudioShell>
	);
}
