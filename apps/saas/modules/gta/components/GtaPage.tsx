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
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";

import { LandingGenerator } from "../../landing/components/LandingGenerator";
import { PublicFooterLinks } from "../../public-content/components/PublicFooterLinks";
import { GTA_PAGES, GTA_SCENES, type GtaIntent } from "../lib/config";
import { GTA_EXAMPLES } from "../lib/examples";
import { GtaWorkbench } from "./GtaWorkbench";

import "../gta.css";

const wallpaperFaq = [
	{
		question: "Can I make a GTA 6 wallpaper from my own photo?",
		answer:
			"Choose Use my photo and upload one clear portrait. The prompt asks to preserve the person's recognizable face, hairstyle and visible clothing while reimagining the setting as coastal action-game key art. Faces and fine details can change, so review your result before downloading.",
	},
	{
		question: "Can I download a wallpaper or create a scene without uploading?",
		answer:
			"The original sample wallpapers below download directly. To make a new environment, choose Create a scene and select one of the six settings. Scene mode creates a landscape without a main human character.",
	},
	{
		question: "How do I fit a wallpaper to an iPhone or Android screen?",
		answer:
			"Phone requests a 9:16 composition with a quieter upper area for your lock-screen clock. Preview & crop offers standard and tall phone crops, position and zoom. Choose the framing that keeps the face clear. Your device's wallpaper settings may apply an additional crop.",
	},
	{
		question: "Can I create a GTA-inspired desktop wallpaper?",
		answer:
			"Choose Desktop for a wide 16:9 composition with the main subject toward the right and calmer space on the left for icons. You can preview the image on a desktop screen and download a crop at its displayed pixel dimensions.",
	},
	{
		question: "What resolution is the download?",
		answer:
			"The editor shows the sizes supported by your selected model. The crop tool shows the source dimensions and the exact exported pixels. Crops use the detail available in the source image and preserve its maximum resolution.",
	},
	{
		question: "Does previewing, cropping or downloading again use credits?",
		answer:
			"Preview, crop and repeat downloads of an image available to you run locally in your browser. Before starting a new generation, review the trial, payment or credit options shown in the editor.",
	},
	{
		question: "Are these official Rockstar wallpapers?",
		answer:
			"These are original AI artworks inspired by fictional coastal action-game illustration. EzImageAI is an independent creative tool and is unaffiliated with Rockstar Games. GTA and Grand Theft Auto are trademarks of their respective owners.",
	},
];

const loadingFaq = [
	{
		question: "What does the GTA loading screen generator create?",
		answer:
			"It creates a single-panel, GTA-inspired illustrated portrait from one clear photo. Choose a scene, horizontal or vertical framing and a left or right portrait position. The result is a static image you can download as a PNG, with an optional name added locally.",
	},
	{
		question: "Is this an actual GTA 6 loading screen?",
		answer:
			"The tool creates original GTA 6-inspired loading-screen artwork for personal creative projects. EzImageAI is independent and unaffiliated with Rockstar Games. Game logos and existing game characters are excluded from the prepared prompt.",
	},
	{
		question: "Can I turn myself into a GTA-style character?",
		answer:
			"Upload a well-lit, unobstructed single-person photo. The prompt preserves recognizable facial structure, hair, skin tone, glasses and visible clothing while using bold contours, painted color and a new scene. Check likeness and small details in your finished image.",
	},
	{
		question: "Does it make an animated loading screen?",
		answer:
			"The output is a static illustration. You can export the clean image or add your name as a separate editable layer before downloading the final PNG.",
	},
	{
		question: "Will changing my name use more credits?",
		answer:
			"Name changes and clean-image exports run in your browser using the same base image. Enter up to 24 characters, preview the layout and download again. A new scene, portrait position, model or generation size applies when you explicitly generate another image.",
	},
	{
		question: "Which image size will I receive?",
		answer:
			"Choose an available size in the editor and review its current quote. The result and export show actual pixel dimensions. Horizontal artwork uses 16:9 composition and vertical artwork uses 9:16 composition.",
	},
	{
		question: "Can I make a phone wallpaper instead?",
		answer:
			"The GTA 6 Wallpaper Generator has phone-first composition, lock-screen and desktop previews, and standard or tall phone cropping. You can start from a portrait or create an environment without a photo.",
	},
];

export function GtaPage({
	intent,
	searchParams = Promise.resolve({}),
}: {
	intent: GtaIntent;
	searchParams?: Promise<CreatePageFilters>;
}) {
	const page = GTA_PAGES[intent];
	const wallpaper = intent === "wallpaper";
	const examples = GTA_EXAMPLES.filter((example) => example.intent === intent);
	const comparisons = examples.filter((example) => example.sourceSrc);
	const hero = examples.find((example) => example.format === "desktop") ?? examples[0]!;
	const faq = wallpaper ? wallpaperFaq : loadingFaq;
	const canonical = new URL(page.path, getBaseUrl()).href;
	const related = GTA_PAGES[wallpaper ? "loading-art" : "wallpaper"];
	const structuredData = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebPage",
				"@id": canonical,
				url: canonical,
				name: page.h1,
				description: page.description,
				inLanguage: "en",
			},
			{
				"@type": "BreadcrumbList",
				itemListElement: [
					{ "@type": "ListItem", position: 1, name: "EzImageAI", item: getBaseUrl() },
					{ "@type": "ListItem", position: 2, name: page.h1, item: canonical },
				],
			},
			{
				"@type": "WebApplication",
				name: page.h1,
				url: canonical,
				applicationCategory: "DesignApplication",
				operatingSystem: "Web browser",
			},
			{
				"@type": "FAQPage",
				mainEntity: faq.map((item) => ({
					"@type": "Question",
					name: item.question,
					acceptedAnswer: { "@type": "Answer", text: item.answer },
				})),
			},
		],
	};
	return (
		<StudioShell>
			<main className={`gta-page gta-page-${intent}`}>
				<script
					type="application/ld+json"
					dangerouslySetInnerHTML={{
						__html: JSON.stringify(structuredData).replaceAll("<", "\\u003c"),
					}}
				/>
				<div className="gta-container">
					<nav className="gta-breadcrumb" aria-label="Breadcrumb">
						<Link href="/">EzImageAI</Link>
						<span aria-hidden="true">/</span>
						<span>{wallpaper ? "GTA 6 wallpaper" : "GTA loading-screen art"}</span>
					</nav>
					<header className="gta-hero">
						<div className="gta-hero-copy">
							<p className="gta-eyebrow">Original AI artwork · GTA-inspired</p>
							<h1>{page.h1}</h1>
							<p className="gta-hero-description">
								{wallpaper
									? "Your photo. A coastal world. Make a wallpaper for your phone or desktop, or download an original scene from the gallery."
									: "Your portrait, in the spotlight. Choose a coastal scene, place yourself in the frame and add your name to your loading-screen illustration."}
							</p>
							<div className="gta-hero-actions">
								<a className="gta-button" href="#gta-editor">
									{wallpaper ? "Make my wallpaper" : "Make my loading-screen art"}
									<span aria-hidden="true">↗</span>
								</a>
								<a className="gta-text-link" href={wallpaper ? "#gta-gallery" : "#gta-comparisons"}>
									{wallpaper ? "Browse original wallpapers" : "Explore portrait styles"}
								</a>
							</div>
						</div>
						<figure className="gta-hero-art">
							<Image
								src={hero.src}
								alt={hero.alt}
								width={hero.width}
								height={hero.height}
								sizes="(max-width: 760px) 100vw, 50vw"
								priority
							/>
							<figcaption>Style preview</figcaption>
						</figure>
					</header>
					<GtaWorkbench key={intent} intent={intent}>
						<Suspense
							fallback={
								<p className="gta-loading" aria-busy="true">
									Loading your editor…
								</p>
							}
						>
							<GtaWorkspace searchParams={searchParams} />
						</Suspense>
					</GtaWorkbench>
					<section
						className="gta-comparisons"
						id="gta-comparisons"
						aria-labelledby="gta-comparisons-title"
					>
						<div className="gta-section-heading">
							<div>
								<p className="gta-eyebrow">Photo to coastal key art</p>
								<h2 id="gta-comparisons-title">
									{wallpaper
										? "A familiar face. A different world."
										: "A portrait with a story to tell."}
								</h2>
							</div>
							<p>
								{wallpaper
									? "Start with a well-lit single-person photo. Keep your face clear and let the setting do the rest."
									: "A clear half-body portrait gives the model room to keep your features and reinterpret the scene. Faces and small details can change."}
							</p>
						</div>
						<div className="gta-comparison-grid">
							{comparisons.map((example) => (
								<article className="gta-comparison" key={example.id}>
									<div className="gta-comparison-images">
										<figure className="gta-comparison-source">
											<Image
												src={example.sourceSrc!}
												alt="Fictional portrait used as the identity reference for this style study"
												width={example.sourceWidth ?? 1024}
												height={example.sourceHeight ?? 1536}
												sizes="(max-width: 760px) 25vw, 12vw"
											/>
											<figcaption>Reference portrait</figcaption>
										</figure>
										<figure className="gta-comparison-result">
											<Image
												src={example.src}
												alt={example.alt}
												width={example.width}
												height={example.height}
												sizes="(max-width: 760px) 65vw, 38vw"
											/>
											<figcaption>Style preview</figcaption>
										</figure>
									</div>
									<p>{GTA_SCENES.find((scene) => scene.id === example.sceneId)?.name}</p>
								</article>
							))}
						</div>
					</section>
					<section className="gta-fit" aria-labelledby="gta-fit-title">
						<div>
							<p className="gta-eyebrow">
								{wallpaper ? "Find your screen's fit" : "Finish it your way"}
							</p>
							<h2 id="gta-fit-title">
								{wallpaper
									? "Room for your clock. Space for your icons."
									: "Your name belongs in the frame."}
							</h2>
							<p>
								{wallpaper
									? "A phone wallpaper needs a quieter sky. A desktop scene needs room to breathe. Choose your composition before generating, then adjust the local crop around the details you want to keep."
									: "Choose the portrait side before generating. The composition leaves space opposite your face for a name you can add, change or remove after the image is ready."}
							</p>
						</div>
						<div className="gta-fit-options">
							<article>
								<h3>{wallpaper ? "Phone wallpaper" : "Clean image"}</h3>
								<p>
									{wallpaper
										? "9:16 generation, standard and tall crops, lock-screen preview."
										: "Download the original artwork and keep the illustrated composition clear."}
								</p>
							</article>
							<article>
								<h3>{wallpaper ? "Desktop wallpaper" : "With my name"}</h3>
								<p>
									{wallpaper
										? "16:9 generation, right-side focal point, icon-space preview."
										: "Add up to 24 characters. The local export fits the name within the reserved area."}
								</p>
							</article>
							<p>
								{wallpaper
									? "The exported image contains your crop. Device frames, clocks and icons stay in the preview."
									: "Name edits use the same base image. Your export shows its actual pixel dimensions."}
							</p>
						</div>
					</section>
					<section className="gta-how" aria-labelledby="gta-how-title">
						<h2 id="gta-how-title">
							{wallpaper
								? "Make it yours, from scene to screen."
								: "From your photo to your own key art."}
						</h2>
						<ol>
							<li>
								<h3>{wallpaper ? "Choose a starting point" : "Upload your portrait"}</h3>
								<p>
									{wallpaper
										? "Upload a clear single-person photo or choose Create a scene. Pick one of the six coastal settings."
										: "Use one clear photo with an unobstructed face and simple pose. A well-lit half-body image works as a starting reference."}
								</p>
							</li>
							<li>
								<h3>Set the composition</h3>
								<p>
									{wallpaper
										? "Choose Phone or Desktop and an available model and size. Review the generation option and cost shown in the editor before starting."
										: "Choose a scene, aspect ratio and portrait side. Review the model, size and generation cost shown in the editor before starting."}
								</p>
							</li>
							<li>
								<h3>{wallpaper ? "Preview and download" : "Add the final detail"}</h3>
								<p>
									{wallpaper
										? "Check the result on the screen preview, adjust its crop and download at the displayed pixel dimensions."
										: "Keep the clean image or type your name in the local preview. Download the finished static PNG."}
								</p>
							</li>
						</ol>
					</section>
					<section className="gta-faq" aria-labelledby="gta-faq-title">
						<h2 id="gta-faq-title">Before you create</h2>
						<div>
							{faq.map((item) => (
								<details key={item.question}>
									<summary>{item.question}</summary>
									<p>{item.answer}</p>
								</details>
							))}
						</div>
					</section>
					<nav className="gta-related" aria-label="Related tools">
						<Link href={related.path}>{related.h1} ↗</Link>
						<Link href="/image-to-image">More photo editing ↗</Link>
						<Link href="/christmas-wallpaper">Christmas Wallpaper Maker ↗</Link>
						<Link href="/pricing">Plans and credits ↗</Link>
						<Link href="/privacy">Photo privacy ↗</Link>
					</nav>
					<p className="gta-trademark">
						Original AI artwork inspired by coastal action-game illustration. GTA and Grand Theft
						Auto are trademarks of their respective owners.
					</p>
				</div>
				<footer className="gta-footer">
					<PublicFooterLinks />
				</footer>
			</main>
		</StudioShell>
	);
}

async function GtaWorkspace({ searchParams }: { searchParams: Promise<CreatePageFilters> }) {
	const session = await getSession();
	if (session && !isAnonymousUser(session.user))
		return (
			<RegisteredWorkspaceBoundary>
				<MainAccountBoundary>
					<RegisteredEditor searchParams={searchParams} />
				</MainAccountBoundary>
			</RegisteredWorkspaceBoundary>
		);
	return <LandingGenerator />;
}
