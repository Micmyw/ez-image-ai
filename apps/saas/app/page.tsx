import { getSession } from "@auth/lib/server";
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

const title = "AI Image Editor No Restrictions — Prompt Editing | EzPic";
const description =
	"AI image editor no restrictions: edit photos with prompts beyond fixed templates. Private images and clear credits; safety and usage limits apply.";

export const metadata: Metadata = {
	title: { absolute: title },
	description,
	alternates: { canonical: new URL("/", getBaseUrl()).href },
	robots: { index: true, follow: true },
	openGraph: {
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
	const structuredData = {
		"@context": "https://schema.org",
		"@type": "WebSite",
		name: "EzPic",
		description,
		url: new URL("/", getBaseUrl()).href,
		inLanguage: "en",
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
