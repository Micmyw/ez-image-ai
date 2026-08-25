import { buildHomeStructuredData, HOME_DESCRIPTION, HOME_TITLE } from "@home/lib/home-seo";
import { PLAN_ENTITLEMENTS } from "@repo/config/client";
import { getBaseUrl } from "@shared/lib/base-url";
import type { Metadata } from "next";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
vi.mock("@analytics", () => ({
	LandingGrowthTracker: () => <span data-growth-tracker="landing" />,
}));
vi.mock("../../../modules/image-editor/components/BeforeAfterDemo", () => ({
	BeforeAfterDemo: () => null,
}));
vi.mock("../../../modules/image-editor/components/FinalCtaSection", () => ({
	FinalCtaSection: () => null,
}));
vi.mock("../../../modules/image-editor/components/HowItWorksSection", () => ({
	HowItWorksSection: () => null,
}));
vi.mock("../../../modules/image-editor/components/ImageEditorHero", () => ({
	ImageEditorHero: () => null,
}));
vi.mock("../../../modules/image-editor/components/NoRestrictionsSection", () => ({
	NoRestrictionsSection: () => null,
}));
vi.mock("../../../modules/image-editor/components/ShowcaseSection", () => ({
	ShowcaseSection: () => null,
}));
vi.mock("../../../modules/image-editor/components/SupportedEditsSection", () => ({
	SupportedEditsSection: () => null,
}));
vi.mock("../../../modules/image-editor/components/TrustSection", () => ({
	TrustSection: () => null,
}));

import Home, { generateMetadata } from "./page";

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
			robots: { index: true, follow: true },
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

	it("keeps localized homepages out of the index", async () => {
		const metadata: Metadata = await generateMetadata({
			params: Promise.resolve({ locale: "de" }),
		});

		expect(metadata.robots).toEqual({ index: false, follow: true });
	});

	it("mounts the consent-aware landing funnel tracker", async () => {
		const markup = renderToStaticMarkup(await Home({ params: Promise.resolve({ locale: "en" }) }));

		expect(markup).toContain('data-growth-tracker="landing"');
	});

	it("publishes Website, Organization, and accurate configured offers without internal claims", () => {
		const canonical = new URL("/", getBaseUrl()).href;
		const buildStructuredData = buildHomeStructuredData as unknown as (
			baseUrl: string,
			availability: {
				creator: Record<"month" | "year", boolean>;
				studio: Record<"month" | "year", boolean>;
			},
		) => { "@context": string; "@graph": Array<Record<string, unknown>> };
		const schema = buildStructuredData(getBaseUrl(), {
			creator: { month: true, year: true },
			studio: { month: true, year: false },
		});
		const graphTypes = schema["@graph"].map((node) => node["@type"]);
		const application = schema["@graph"].find((node) => node["@type"] === "SoftwareApplication");
		const offers = application?.offers as Array<Record<string, unknown>>;
		const expectedOffers = PLAN_ENTITLEMENTS.flatMap((plan) =>
			plan.id === "creator"
				? plan.prices
				: plan.id === "studio"
					? plan.prices.filter((price) => price.interval === "month")
					: [],
		);

		expect(schema["@context"]).toBe("https://schema.org");
		expect(graphTypes).toEqual(["WebSite", "Organization", "SoftwareApplication"]);
		expect(schema["@graph"]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					"@type": "WebSite",
					"@id": `${canonical}#website`,
					name: "EzPic",
					url: canonical,
				}),
				expect.objectContaining({
					"@type": "Organization",
					"@id": `${canonical}#organization`,
					name: "EzPic",
					url: canonical,
				}),
			]),
		);
		expect(offers).toHaveLength(expectedOffers.length);
		expect(offers.map(({ price }) => Number(price))).toEqual(
			expectedOffers.map(({ amount }) => amount),
		);
		expect(offers.every(({ priceCurrency }) => priceCurrency === "USD")).toBe(true);
		expect(offers.every(({ url }) => url === new URL("/pricing", getBaseUrl()).href)).toBe(true);
		expect(JSON.stringify(schema)).not.toMatch(
			/"(?:provider|modelId|providerCost|rawResponse|(?:aggregate)?rating|review)"\s*:/i,
		);
	});
});
