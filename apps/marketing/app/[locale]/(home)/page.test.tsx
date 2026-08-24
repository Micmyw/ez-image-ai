import { buildHomeStructuredData, HOME_DESCRIPTION, HOME_TITLE } from "@home/lib/home-seo";
import { getBaseUrl } from "@shared/lib/base-url";
import type { Metadata } from "next";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({ setRequestLocale: vi.fn() }));
vi.mock("@generator/components/MarketingGenerator", () => ({
	MarketingGenerator: () => null,
}));
vi.mock("@home/components/FaqSection", () => ({ FaqSection: () => null }));
vi.mock("@home/components/FeaturesSection", () => ({ FeaturesSection: () => null }));
vi.mock("@home/components/HeroSection", () => ({ HeroSection: () => null }));
vi.mock("@home/components/NewsletterSection", () => ({ NewsletterSection: () => null }));
vi.mock("@home/components/PricingSection", () => ({ PricingSection: () => null }));

import { generateMetadata } from "./page";

describe("EzPic homepage SEO contract", () => {
	it("publishes the exact title, description, canonical, and social metadata", async () => {
		const metadata: Metadata = await generateMetadata({
			params: Promise.resolve({ locale: "en" }),
		});
		const canonical = new URL("/", getBaseUrl()).href;

		expect(metadata).toMatchObject({
			title: { absolute: HOME_TITLE },
			description: HOME_DESCRIPTION,
			alternates: { canonical },
			openGraph: {
				title: HOME_TITLE,
				description: HOME_DESCRIPTION,
				type: "website",
				url: canonical,
			},
			twitter: {
				card: "summary_large_image",
				title: HOME_TITLE,
				description: HOME_DESCRIPTION,
			},
		});
	});

	it("describes only the visible web image editor without offers, ratings, or provider claims", () => {
		const canonical = new URL("/", getBaseUrl()).href;
		const schema = buildHomeStructuredData(getBaseUrl());

		expect(schema).toEqual({
			"@context": "https://schema.org",
			"@graph": [
				{
					"@type": "WebSite",
					"@id": `${canonical}#website`,
					name: "EzPic",
					url: canonical,
				},
				{
					"@type": "SoftwareApplication",
					"@id": `${canonical}#application`,
					name: "EzPic",
					applicationCategory: "MultimediaApplication",
					operatingSystem: "Web",
					description: HOME_DESCRIPTION,
					url: canonical,
				},
			],
		});
		expect(JSON.stringify(schema)).not.toMatch(
			/"(?:provider|modelId|(?:aggregate)?rating|review|offers?|price)"\s*:/i,
		);
	});
});
