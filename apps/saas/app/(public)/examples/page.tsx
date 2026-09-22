import { StudioShell } from "@shared/components/studio/StudioShell";

import { ShowcaseSection } from "../../../modules/landing/components/ShowcaseSection";
import { PublicFooterLinks } from "../../../modules/public-content/components/PublicFooterLinks";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export const metadata = createPublicPageMetadata({
	path: "/examples",
	title: "AI Image Editing Examples",
	description: "Browse original image ideas and choose a prompt to start creating with EzImageAI.",
	index: false,
});

export default function ExamplesPage() {
	return (
		<StudioShell>
			<main className="studio-home">
				<ShowcaseSection standalone />
				<footer className="py-8 container">
					<PublicFooterLinks className="gap-4 text-sm flex flex-wrap text-muted-foreground" />
				</footer>
			</main>
		</StudioShell>
	);
}
