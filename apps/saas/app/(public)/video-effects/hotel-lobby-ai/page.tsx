import { StudioShell } from "@shared/components/studio/StudioShell";
import { getBaseUrl } from "@shared/lib/base-url";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PublicFooterLinks } from "../../../../modules/public-content/components/PublicFooterLinks";
import { createPublicPageMetadata } from "../../../../modules/public-content/lib/metadata";
import { VideoEffectArticle } from "../../../../modules/video-effects/components/VideoEffectArticle";
import { VideoEffectGenerator } from "../../../../modules/video-effects/components/VideoEffectGenerator";
import {
	getVideoEffectStructuredData,
	HOTEL_LOBBY_DESCRIPTION,
	HOTEL_LOBBY_PATH,
	HOTEL_LOBBY_TITLE,
	hotelLobbyContent,
} from "../../../../modules/video-effects/lib/content";

import "../../../../modules/video-effects/video-effects.css";
import { videoEffectMayIndex } from "../../../../modules/video-effects/lib/indexing";

type Search = { job?: string | string[]; lang?: string | string[] };
export async function generateMetadata({ searchParams }: { searchParams: Promise<Search> }) {
	const search = await searchParams;
	return createPublicPageMetadata({
		path: HOTEL_LOBBY_PATH,
		title: HOTEL_LOBBY_TITLE,
		description: HOTEL_LOBBY_DESCRIPTION,
		brandName: "EzImageAI",
		index: videoEffectMayIndex(hotelLobbyContent.status === "published", search),
	});
}

export default async function HotelLobbyVideoPage({
	searchParams,
}: {
	searchParams: Promise<Search>;
}) {
	const t = await getTranslations("videoEffects");
	const params = await searchParams;
	const jobId =
		typeof params.job === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(params.job) ? params.job : null;
	return (
		<StudioShell>
			<main className="ve-page">
				<script
					type="application/ld+json"
					dangerouslySetInnerHTML={{
						__html: JSON.stringify(
							getVideoEffectStructuredData(hotelLobbyContent, getBaseUrl()),
						).replaceAll("<", "\\u003c"),
					}}
				/>
				<header className="ve-intro">
					<nav aria-label="Breadcrumb">
						<Link href="/">EzImageAI</Link>
						<span aria-hidden>/</span>
						<span>Hotel Lobby AI</span>
					</nav>
					{hotelLobbyContent.status !== "published" && <span className="ve-beta">{t("beta")}</span>}
					<h1>Hotel Lobby AI Video Generator</h1>
					<p>{t("description")}</p>
				</header>
				<VideoEffectGenerator initialJobId={jobId} samples={hotelLobbyContent.samples} />
				<VideoEffectArticle />
			</main>
			<PublicFooterLinks />
		</StudioShell>
	);
}
