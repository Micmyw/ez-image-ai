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
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Suspense } from "react";

import { LandingGenerator } from "../../landing/components/LandingGenerator";
import { PublicFooterLinks } from "../../public-content/components/PublicFooterLinks";
import { buildColoringPrompt } from "../lib/coloring-prompt";
import { coloringFaq, coloringSteps, coloringStructuredData } from "../lib/content";
import { ColoringControls } from "./ColoringControls";
import { ColoringExample } from "./ColoringExample";

import "../coloring.css";

export async function PhotoToColoringPage({
	searchParams = Promise.resolve({}),
}: {
	searchParams?: Promise<CreatePageFilters>;
}) {
	const t = await getTranslations("coloring");
	return (
		<StudioShell>
			<main className="coloring-page">
				<script
					type="application/ld+json"
					dangerouslySetInnerHTML={{
						__html: JSON.stringify(coloringStructuredData(getBaseUrl())).replaceAll("<", "\\u003c"),
					}}
				/>
				<div className="coloring-container">
					<header className="coloring-intro">
						<nav aria-label="Breadcrumb">
							<Link href="/">EzImageAI</Link>
							<span aria-hidden="true">/</span>
							<span>Photo to Coloring Page</span>
						</nav>
						<h1>
							Turn a photo into a <span>coloring page</span>
						</h1>
						<p>
							Start with a photo you love. Turn it into clean outlines, make room for color, and
							print a page that is yours.
						</p>
					</header>
					<ToolPromptProvider initialPrompt={buildColoringPrompt()}>
						<div className="coloring-workbench">
							<section
								className="coloring-editor"
								id="image-editor"
								aria-labelledby="coloring-upload-title"
							>
								<h2 id="coloring-upload-title">{t("uploadTitle")}</h2>
								<p className="coloring-editor-intro">{t("uploadHint")}</p>
								<ColoringControls />
								<Suspense fallback={<p aria-busy="true">{t("loading")}</p>}>
									<ColoringWorkspace searchParams={searchParams} />
								</Suspense>
							</section>
							<ColoringExample />
						</div>
					</ToolPromptProvider>
					<section className="coloring-answer" aria-labelledby="coloring-definition">
						<h2 id="coloring-definition">Your photo, ready for a different kind of creativity.</h2>
						<p>
							A photo-to-coloring-page converter turns an existing picture into black outlines with
							white areas to color. EzImageAI uses your uploaded photo as a reference, with controls
							for detail and background. Download the result as an image, or fit it to A4 or US
							Letter for printing.
						</p>
						<div className="coloring-use-cases">
							<p>
								<strong>Pets & portraits</strong>A familiar face becomes a personal coloring
								activity.
							</p>
							<p>
								<strong>Family & classroom</strong>Start with your own permitted photos for a shared
								activity.
							</p>
							<p>
								<strong>Objects & memories</strong>Try a favorite flower, a toy or a simple travel
								photo.
							</p>
						</div>
					</section>
					<section className="coloring-section" aria-labelledby="coloring-how">
						<h2 id="coloring-how">How to turn a photo into a coloring page</h2>
						<ol className="coloring-steps">
							{coloringSteps.map((step) => (
								<li key={step.title}>
									<h3>{step.title}</h3>
									<p>{step.body}</p>
								</li>
							))}
						</ol>
					</section>
					<section className="coloring-section coloring-tips" aria-labelledby="coloring-tips">
						<div>
							<h2 id="coloring-tips">Choose the lines for the person coloring.</h2>
							<p>
								Simple outlines leave more room for crayons. Detailed outlines keep more shapes for
								careful pencil work. These choices guide the AI; always review the actual result.
							</p>
						</div>
						<div className="coloring-table-wrap">
							<table>
								<caption>Coloring page detail options</caption>
								<thead>
									<tr>
										<th scope="col">Setting</th>
										<th scope="col">What it asks for</th>
										<th scope="col">Useful for</th>
									</tr>
								</thead>
								<tbody>
									<tr>
										<th scope="row">Simple</th>
										<td>Thicker lines, larger spaces, fewer textures</td>
										<td>Easy coloring and crayons</td>
									</tr>
									<tr>
										<th scope="row">Balanced</th>
										<td>Clear features and moderate detail</td>
										<td>Everyday portraits and pets</td>
									</tr>
									<tr>
										<th scope="row">Detailed</th>
										<td>Thinner contours and smaller shapes</td>
										<td>Patient pencil coloring</td>
									</tr>
								</tbody>
							</table>
						</div>
					</section>
					<section className="coloring-section coloring-faq" aria-labelledby="coloring-faq">
						<h2 id="coloring-faq">Photo to coloring page: common questions</h2>
						<div>
							{coloringFaq.map((faq) => (
								<details key={faq.question}>
									<summary>{faq.question}</summary>
									<p>{faq.answer}</p>
								</details>
							))}
						</div>
					</section>
					<section className="coloring-related" aria-label="Related tools and guidance">
						<Link href="/image-to-image">More image-to-image edits ↗</Link>
						<Link href="/docs/image-editing">Image editing guide ↗</Link>
						<Link href="/pricing">Plans and credits ↗</Link>
						<Link href="/privacy">How photos are handled ↗</Link>
					</section>
				</div>
				<footer className="coloring-footer">
					<PublicFooterLinks />
				</footer>
			</main>
		</StudioShell>
	);
}

export async function ColoringWorkspace({
	searchParams,
}: {
	searchParams: Promise<CreatePageFilters>;
}) {
	const session = await getSession();
	return session && !isAnonymousUser(session.user) ? (
		<RegisteredWorkspaceBoundary>
			<MainAccountBoundary>
				<RegisteredEditor searchParams={searchParams} requireReference />
			</MainAccountBoundary>
		</RegisteredWorkspaceBoundary>
	) : (
		<LandingGenerator requireReference />
	);
}
