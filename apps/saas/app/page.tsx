import { getBaseUrl } from "@shared/lib/base-url";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { LandingPage } from "../modules/landing/components/LandingPage";
import { HOME_FAQ_KEYS } from "../modules/landing/lib/faq";

const title = "EzPic AI Image Editor — Edit Images With a Prompt";
const description =
	"Upload an image, describe the change, and start a private AI edit directly from the EzPic landing page.";

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

export default async function HomePage() {
	const t = await getTranslations();
	const structuredData = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "SoftwareApplication",
				name: "EzPic",
				applicationCategory: "MultimediaApplication",
				operatingSystem: "Web",
				description,
				url: new URL("/", getBaseUrl()).href,
			},
			{
				"@type": "FAQPage",
				mainEntity: HOME_FAQ_KEYS.map((key) => ({
					"@type": "Question",
					name: t(`faq.items.${key}.question`),
					acceptedAnswer: {
						"@type": "Answer",
						text: t(`faq.items.${key}.answer`),
					},
				})),
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
			<LandingPage />
		</>
	);
}
