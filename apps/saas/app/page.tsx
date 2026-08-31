import { getBaseUrl } from "@shared/lib/base-url";
import type { Metadata } from "next";

import { LandingPage } from "../modules/landing/components/LandingPage";

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

export default function HomePage() {
	const structuredData = {
		"@context": "https://schema.org",
		"@type": "SoftwareApplication",
		name: "EzPic",
		applicationCategory: "MultimediaApplication",
		operatingSystem: "Web",
		description,
		url: new URL("/", getBaseUrl()).href,
		offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
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
