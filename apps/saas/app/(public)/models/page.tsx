import { StudioShell } from "@shared/components/studio/StudioShell";
import Image from "next/image";
import Link from "next/link";

import { INSPIRATION, MODEL_PAGES, modelPath } from "../../../modules/models/lib/model-pages";
import { PublicFooterLinks } from "../../../modules/public-content/components/PublicFooterLinks";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

import "../../../modules/models/models.css";

export const metadata = createPublicPageMetadata({
	path: "/models",
	title: "AI Image Models — Find Your Creative Direction",
	description:
		"Explore GPT Image, Nano Banana, and Seedream in EzPic. Find creative directions, original inspiration, and a workspace for text to image and reference editing.",
	index: true,
});

export default function ModelsPage() {
	return (
		<StudioShell>
			<main className="model-page model-directory">
				<section className="model-directory-hero">
					<p className="model-eyebrow">The EzPic model collection</p>
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
						{["GPT Image", "Nano Banana", "Seedream"].map((family) => (
							<a key={family} href={`#${family.toLowerCase().replaceAll(" ", "-")}`}>
								{family}
							</a>
						))}
					</nav>
				</section>
				{["GPT Image", "Nano Banana", "Seedream"].map((family) => (
					<section
						className="model-collection"
						key={family}
						id={family.toLowerCase().replaceAll(" ", "-")}
					>
						<div className="model-section-heading">
							<h2>{family}</h2>
							<span>
								{family === "GPT Image"
									? "Prompts, composition, and visual detail"
									: family === "Nano Banana"
										? "Characters, products, and style exploration"
										: "Atmosphere, light, and spatial storytelling"}
							</span>
						</div>
						<div className="model-directory-grid">
							{MODEL_PAGES.filter((model) => model.family === family).map((model) => (
								<Link href={modelPath(model.key)} className="model-directory-card" key={model.key}>
									<div className="model-directory-image">
										<Image
											src={`/images/models/${model.artwork}.webp`}
											alt={INSPIRATION[model.artwork].alt}
											width={1024}
											height={1536}
											sizes="(max-width: 640px) 90vw, (max-width: 1100px) 45vw, 22vw"
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
					Original concept artwork for creative inspiration. These images are not model benchmarks.
					Open a model page to explore prompts and check current workspace availability.
				</p>
				<footer className="model-footer">
					<Link href="/">EzPic</Link>
					<PublicFooterLinks className="model-footer-links" />
				</footer>
			</main>
		</StudioShell>
	);
}
