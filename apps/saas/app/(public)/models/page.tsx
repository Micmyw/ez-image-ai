import { StudioShell } from "@shared/components/studio/StudioShell";
import Link from "next/link";

import { ModelArtwork } from "../../../modules/models/components/ModelArtwork";
import { MODEL_PAGES, modelPath } from "../../../modules/models/lib/model-pages";
import { PublicFooterLinks } from "../../../modules/public-content/components/PublicFooterLinks";
import type { PublicMetadataProps } from "../../../modules/public-content/lib/indexing";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

import "../../../modules/models/models.css";

export async function generateMetadata(props: PublicMetadataProps) {
	const { searchParams } = props ?? {};
	return createPublicPageMetadata({
		searchParams: await searchParams,
		path: "/models",
		title: "AI Image Models — Find Your Creative Direction",
		description:
			"Explore MiniMax H3 Image, GPT Image, Nano Banana, and Seedream in EzImageAI. Find examples, prompts, and a workspace for text to image and photo editing.",
		index: true,
	});
}

export default function ModelsPage() {
	return (
		<StudioShell>
			<main className="model-page model-directory">
				<section className="model-directory-hero">
					<p className="model-eyebrow">The EzImageAI model collection</p>
					<h1>
						Find your
						<br />
						<span>creative direction.</span>
					</h1>
					<p className="model-intro">
						A poster with something to say. A product in a new light. A scene that feels like a
						story. Choose a model and make it yours.
					</p>
					<nav className="model-family-nav" aria-label="Model families">
						{["MiniMax", "GPT Image", "Nano Banana", "Seedream"].map((family) => (
							<a key={family} href={`#${family.toLowerCase().replaceAll(" ", "-")}`}>
								{family}
							</a>
						))}
					</nav>
				</section>
				{["MiniMax", "GPT Image", "Nano Banana", "Seedream"].map((family) => (
					<section
						className="model-collection"
						key={family}
						id={family.toLowerCase().replaceAll(" ", "-")}
					>
						<div className="model-section-heading">
							<h2>{family}</h2>
							<span>
								{family === "MiniMax"
									? "Product detail, typography and photo editing"
									: family === "GPT Image"
										? "Prompts, composition, and visual detail"
										: family === "Nano Banana"
											? "Characters, products, and style exploration"
											: "Atmosphere, light, and spatial storytelling"}
							</span>
						</div>
						{family === "GPT Image" && (
							<div className="mb-6 gap-4 sm:grid-cols-2 grid">
								{[
									["flare", "Flare", "Speed-focused creation with medium quality."],
									[
										"sunburst",
										"Sunburst",
										"Detailed output and consistent edits with high quality.",
									],
								].map(([key, label, description]) => (
									<Link
										key={key}
										href={`/gpt-image-2-6?model=image-gpt-image-2-6-${key}`}
										prefetch={false}
										className="border-white/10 bg-white/[0.025] p-5 hover:border-violet-300/40 rounded-xl border transition"
									>
										<h3 className="font-semibold text-white">
											GPT Image 2.6 {label} <span aria-hidden="true">↗</span>
										</h3>
										<p className="mt-2 text-sm leading-6 text-[#b7acbf]">{description}</p>
										<p className="mt-2 text-xs text-violet-200">
											Explore images, static SVG and GIF
										</p>
									</Link>
								))}
							</div>
						)}
						<div className="model-directory-grid">
							{family === "MiniMax" && (
								<Link href="/minimax-h3-image" className="model-directory-card">
									<div className="model-directory-image">
										<img
											src="/images/models/minimax-h3/ferry-poster.webp"
											width={1200}
											height={1200}
											alt="Lantern Ferry festival poster example supplied by Kie"
											loading="lazy"
											decoding="async"
										/>
									</div>
									<div className="model-directory-card-copy">
										<h3>
											MiniMax H3 Image <span aria-hidden="true">↗</span>
										</h3>
										<p>Detailed images and a new look for your photos.</p>
										<span>1K / 2K / 4K · Example from Kie</span>
									</div>
								</Link>
							)}
							{MODEL_PAGES.filter((model) => model.family === family).map((model) => (
								<Link href={modelPath(model.key)} className="model-directory-card" key={model.key}>
									<div className="model-directory-image">
										<ModelArtwork
											artwork={model.artwork}
											sizes="(max-width: 380px) calc(100vw - 28px), (max-width: 760px) calc((100vw - 54px) / 2), (max-width: 1100px) calc((100vw - 78px) / 2), (max-width: 1500px) calc((100vw - 150px) / 4), 338px"
										/>
									</div>
									<div className="model-directory-card-copy">
										<h3>
											{model.name}
											<span aria-hidden="true">↗</span>
										</h3>
										<p>{model.lead}</p>
										<span>{model.tags[0]}</span>
									</div>
								</Link>
							))}
						</div>
					</section>
				))}
				<p className="model-artwork-note">
					Explore original EzImageAI concepts and credited model examples. Open a model page to try
					a prompt.
				</p>
				<footer className="model-footer">
					<Link href="/">EzImageAI</Link>
					<PublicFooterLinks className="model-footer-links" />
				</footer>
			</main>
		</StudioShell>
	);
}
