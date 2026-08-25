import type { Metadata } from "next";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({ setRequestLocale: vi.fn() }));
vi.mock("@home/components/PricingSection", () => ({
	PricingSection: () => <section data-test="shared-pricing">Shared pricing</section>,
}));

import PricingPage, { generateMetadata } from "./page";

describe("standalone pricing page", () => {
	it("has accurate English metadata, canonical, social cards, and index boundary", async () => {
		const metadata: Metadata = await generateMetadata({
			params: Promise.resolve({ locale: "en" }),
		});

		expect(metadata).toMatchObject({
			title: { absolute: "AI Image Editor Pricing | EzPic" },
			description:
				"Compare EzPic Free, Creator, and Studio plans with transparent monthly credits and image editing limits.",
			alternates: { canonical: expect.stringMatching(/\/pricing$/) },
			robots: { index: true, follow: true },
			openGraph: {
				type: "website",
				url: expect.stringMatching(/\/pricing$/),
			},
			twitter: { card: "summary_large_image" },
		});

		const localized = await generateMetadata({
			params: Promise.resolve({ locale: "fr" }),
		});
		expect(localized.robots).toEqual({ index: false, follow: true });
	});

	it("renders one H1 and reuses the shared entitlement-backed pricing table", async () => {
		const markup = renderToStaticMarkup(
			await PricingPage({ params: Promise.resolve({ locale: "en" }) }),
		);

		expect(markup.match(/<h1(?:\s|>)/g)).toHaveLength(1);
		expect(markup).toContain("Simple, transparent pricing for private image edits");
		expect(markup).toContain('data-test="shared-pricing"');
	});
});
