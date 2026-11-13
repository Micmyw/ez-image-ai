import { getSession } from "@auth/lib/server";
import { config } from "@config";
import {
	RegisteredEditor,
	type CreatePageFilters,
} from "@media/components/editor/RegisteredEditor";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { MainAccountBoundary } from "@shared/components/MainAccountBoundary";
import { RegisteredWorkspaceBoundary } from "@shared/components/RegisteredWorkspaceBoundary";
import { getBaseUrl } from "@shared/lib/base-url";
import { getLocale, getTranslations } from "next-intl/server";

import { LandingPage } from "../modules/landing/components/LandingPage";
import { publicPagePath, type PublicMetadataProps } from "../modules/public-content/lib/indexing";
import { createPublicPageMetadata } from "../modules/public-content/lib/metadata";

const title = `AI Image Editor No Restrictions — Prompt Editing | ${config.appName}`;
const description =
	"AI image editor no restrictions: edit photos with prompts beyond fixed templates. Private images and clear credits; safety and usage limits apply.";

export async function generateMetadata(props: PublicMetadataProps) {
	const { searchParams } = props ?? {};
	const locale = await getLocale();
	const t = await getTranslations();
	return createPublicPageMetadata({
		path: "/",
		title: locale === "en" ? title : t("home.hero.title"),
		description: locale === "en" ? description : t("home.hero.subtitle"),
		index: true,
		searchParams: await searchParams,
	});
}

export default async function HomePage({
	searchParams = Promise.resolve({}),
}: {
	searchParams?: Promise<CreatePageFilters>;
}) {
	const session = await getSession();
	const registered = Boolean(session && !isAnonymousUser(session.user));
	const locale = await getLocale();
	const t = await getTranslations();
	const homeUrl = new URL(publicPagePath("/", locale), getBaseUrl()).href;
	const organizationUrl = new URL("/", getBaseUrl()).href;
	const organizationId = `${organizationUrl}#organization`;
	const structuredData = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebSite",
				"@id": `${homeUrl}#website`,
				name: config.appName,
				alternateName: "EzImage AI",
				description: locale === "en" ? description : t("home.hero.subtitle"),
				url: homeUrl,
				inLanguage: locale,
				publisher: { "@id": organizationId },
			},
			{
				"@type": "Organization",
				"@id": organizationId,
				name: config.appName,
				url: organizationUrl,
				logo: new URL("/icon.png", homeUrl).href,
			},
		],
	};

	return (
		<>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(structuredData).replaceAll("<", "\\u003c"),
				}}
			/>
			{registered ? (
				<RegisteredWorkspaceBoundary>
					<MainAccountBoundary>
						<LandingPage editor={<RegisteredEditor searchParams={searchParams} />} />
					</MainAccountBoundary>
				</RegisteredWorkspaceBoundary>
			) : (
				<LandingPage />
			)}
		</>
	);
}
