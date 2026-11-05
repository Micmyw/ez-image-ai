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
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Suspense } from "react";

import { LandingGenerator } from "../../landing/components/LandingGenerator";
import { PublicFooterLinks } from "../../public-content/components/PublicFooterLinks";
import { CHRISTMAS_DESCRIPTION, CHRISTMAS_PATH, CHRISTMAS_TITLE } from "../lib/wallpaper";
import { ChristmasWorkbench } from "./ChristmasWorkbench";

import "../christmas.css";

const faq = [
	{
		question: "Can I make a Christmas wallpaper from my own photo?",
		answer:
			"Yes. Choose Use my photo, upload a clear photo and select a style. The instructions ask to preserve the subject's features and clothing while changing the scene. Check faces and small details in the finished image; identity preservation is not guaranteed.",
	},
	{
		question: "Can I create a Christmas wallpaper without a photo?",
		answer:
			"Choose Create a scene. Pink Christmas and Dark Christmas Lights work especially well as simple backgrounds. You can edit the prepared prompt before generating.",
	},
	{
		question: "How do I make a Christmas phone wallpaper that leaves room for the clock?",
		answer:
			"Choose Phone to request a tall image with the subject lower in the frame and a quieter upper third. After generation, choose Preview & crop. Try a standard or tall phone crop and move the image until the clock leaves the face clear. Device previews are illustrative; your phone may crop differently.",
	},
	{
		question: "Can I download a Christmas desktop wallpaper?",
		answer:
			"Yes. Desktop requests a wide 16:9 scene with the main subject toward the right and space for icons on the left. The crop tool also offers a desktop preview. The downloaded PNG contains only the image.",
	},
	{
		question: "Does cropping use credits?",
		answer:
			"No. Previewing, moving and cropping an image already available to you happens in your browser and does not start another generation. Creating or regenerating an image follows the quote and funding options shown in the editor.",
	},
	{
		question: "What resolution will I download?",
		answer:
			"The editor shows the available generation sizes. Preview & crop displays the exact pixel dimensions of your download. It crops or reduces the image without enlarging it, so a 1K result is not presented as a native 4K wallpaper.",
	},
	{
		question: "Can I use a pet or couple photo?",
		answer:
			"Use a clear pet photo for Pet Under the Tree. An existing couple photo can be used as one reference, but check both faces carefully. This tool does not combine separate portraits. Sample artwork illustrates styles, not a guarantee for your particular photo.",
	},
	{
		question: "Are my uploaded photos public?",
		answer:
			"Your uploads and generated results use EzImageAI's private media workflow. They are not automatically added to this page's style gallery. See the Privacy Policy for storage, processing and deletion details.",
	},
];

export async function ChristmasWallpaperPage({
	searchParams = Promise.resolve({}),
}: {
	searchParams?: Promise<CreatePageFilters>;
}) {
	const t = await getTranslations("christmas");
	const baseUrl = getBaseUrl();
	const structuredData = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebPage",
				"@id": new URL(CHRISTMAS_PATH, baseUrl).href,
				name: CHRISTMAS_TITLE,
				description: CHRISTMAS_DESCRIPTION,
				inLanguage: "en",
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
			<main className="christmas-page">
				<div className="christmas-snow" aria-hidden="true" />
				<script
					type="application/ld+json"
					dangerouslySetInnerHTML={{
						__html: JSON.stringify(structuredData).replaceAll("<", "\\u003c"),
					}}
				/>
				<div className="christmas-container">
					<header className="christmas-hero">
						<nav aria-label="Breadcrumb">
							<Link href="/">EzImageAI</Link>
							<span>/</span>
							<span>Christmas wallpaper</span>
						</nav>
						<p className="christmas-eyebrow">Your screen, in the holiday spirit</p>
						<h1>
							Christmas wallpaper.
							<br />
							<em>A little more you.</em>
						</h1>
						<p>
							Turn your photo into a festive wallpaper, or create a Christmas scene for your phone
							or desktop. Pick a look. Add your touch. Make room for a little magic.
						</p>
					</header>
					<ChristmasWorkbench>
						<Suspense fallback={<p aria-busy="true">{t("loading")}</p>}>
							<ChristmasWorkspace searchParams={searchParams} />
						</Suspense>
					</ChristmasWorkbench>
					<section className="christmas-how" aria-labelledby="christmas-how-title">
						<div className="christmas-section-heading">
							<div>
								<p className="christmas-eyebrow">From an idea to your everyday screen</p>
								<h2 id="christmas-how-title">Your wallpaper, in three steps.</h2>
							</div>
						</div>
						<ol>
							<li>
								<span>1</span>
								<h3>Choose your Christmas</h3>
								<p>
									Pick a style and a phone or desktop layout. Upload your photo, or start with a
									scene.
								</p>
							</li>
							<li>
								<span>2</span>
								<h3>Make it yours</h3>
								<p>
									Keep the prepared prompt or add a detail. Review your settings and the current
									quote before generating.
								</p>
							</li>
							<li>
								<span>3</span>
								<h3>Find the perfect fit</h3>
								<p>
									Preview the result, adjust its crop and download. Set it as your wallpaper in your
									device's settings.
								</p>
							</li>
						</ol>
					</section>
					<section className="christmas-fit" aria-labelledby="christmas-fit-title">
						<div>
							<p className="christmas-eyebrow">Made for the way you use it</p>
							<h2 id="christmas-fit-title">
								A face below the clock.
								<br />A little space for your icons.
							</h2>
							<p>
								A Christmas phone wallpaper needs a different composition from a desktop background.
								Choose the screen before generating, then fine-tune the crop without another
								generation.
							</p>
						</div>
						<div className="christmas-fit-specs">
							<article>
								<span>PHONE</span>
								<h3>Room at the top</h3>
								<p>9:16 generation · standard and tall crops · lock-screen preview</p>
							</article>
							<article>
								<span>DESKTOP</span>
								<h3>A wider winter world</h3>
								<p>16:9 generation · room for icons · desktop preview</p>
							</article>
							<p>Preview controls stay on screen. Your download is just the wallpaper.</p>
						</div>
					</section>
					<section className="christmas-faq" aria-labelledby="christmas-faq-title">
						<h2 id="christmas-faq-title">A few things before you create.</h2>
						<div>
							{faq.map((item) => (
								<details key={item.question}>
									<summary>{item.question}</summary>
									<p>{item.answer}</p>
								</details>
							))}
						</div>
					</section>
					<nav className="christmas-related" aria-label="Related tools">
						<Link href="/image-to-image">More photo edits ↗</Link>
						<Link href="/docs/image-editing">Image editing guide ↗</Link>
						<Link href="/pricing">Plans and credits ↗</Link>
						<Link href="/privacy">Photo privacy ↗</Link>
					</nav>
				</div>
				<footer className="christmas-footer">
					<PublicFooterLinks />
				</footer>
			</main>
		</StudioShell>
	);
}

async function ChristmasWorkspace({ searchParams }: { searchParams: Promise<CreatePageFilters> }) {
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
