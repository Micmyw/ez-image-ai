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
import type { Metadata } from "next";

import { LandingPage } from "../modules/landing/components/LandingPage";

const title = `AI Image Editor No Restrictions — Prompt Editing | ${config.appName}`;
const description =
	"AI image editor no restrictions: edit photos with prompts beyond fixed templates. Private images and clear credits; safety and usage limits apply.";

export const metadata: Metadata = {
	title: { absolute: title },
	description,
	alternates: { canonical: new URL("/", getBaseUrl()).href },
	robots: { index: true, follow: true },
	openGraph: {
		siteName: config.appName,
		title,
		description,
		type: "website",
		url: new URL("/", getBaseUrl()).href,
	},
	twitter: { card: "summary_large_image", title, description },
};

export default async function HomePage({
	searchParams = Promise.resolve({}),
}: {
	searchParams?: Promise<CreatePageFilters>;
}) {
	const session = await getSession();
	const registered = Boolean(session && !isAnonymousUser(session.user));
	const homeUrl = new URL("/", getBaseUrl()).href;
	const organizationId = `${homeUrl}#organization`;
	const structuredData = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebSite",
				"@id": `${homeUrl}#website`,
				name: config.appName,
				alternateName: "EzImage AI",
				description,
				url: homeUrl,
				inLanguage: "en",
				publisher: { "@id": organizationId },
			},
			{
				"@type": "Organization",
				"@id": organizationId,
				name: config.appName,
				url: homeUrl,
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
