import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/config/client", () => ({
	getPlanUsageEstimate: () => ({ qualityEdits: 1, standardEdits: 10 }),
	getPublicConfig: () => ({ brand: { siteName: "EzPic" } }),
	PLAN_ENTITLEMENTS: [
		{
			id: "free",
			monthlyCredits: 25,
			maximumConcurrentJobs: 1,
			maximumInputBytes: 10 * 1024 * 1024,
			allowedProducts: ["image-fast"],
			prices: [],
		},
		{
			id: "creator",
			monthlyCredits: 700,
			maximumConcurrentJobs: 3,
			maximumInputBytes: 20 * 1024 * 1024,
			allowedProducts: ["image-fast", "image-quality"],
			prices: [
				{ amount: 19, currency: "USD", interval: "month" },
				{ amount: 190, currency: "USD", interval: "year" },
			],
		},
		{
			id: "studio",
			monthlyCredits: 3_000,
			maximumConcurrentJobs: 10,
			maximumInputBytes: 20 * 1024 * 1024,
			allowedProducts: ["image-fast", "image-quality"],
			prices: [
				{ amount: 79, currency: "USD", interval: "month" },
				{ amount: 790, currency: "USD", interval: "year" },
			],
		},
	],
}));

vi.mock("next-intl/server", () => ({
	getLocale: async () => "en",
	getTranslations: async () => createTranslator(),
}));

vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

vi.mock("@repo/ui/components/logo", () => ({
	Logo: ({ label }: { label?: string }) => <span>{label}</span>,
}));
vi.mock("@payments/components/PublicPricingPlans", () => ({
	PublicPricingPlans: () => <section />,
}));

vi.mock("./LandingGenerator", () => ({ LandingGenerator: () => <div /> }));
vi.mock("./BeforeAfterDemo", () => ({ BeforeAfterDemo: () => <section /> }));
vi.mock("./ShowcaseSection", () => ({ ShowcaseSection: () => <section /> }));
vi.mock("./CreatorWorkflowsSection", () => ({ CreatorWorkflowsSection: () => <section /> }));
vi.mock("../../public-content/components/PublicFooterLinks", () => ({
	PublicFooterLinks: () => null,
}));

import { LandingPage } from "./LandingPage";

describe("LandingPage hero hierarchy", () => {
	it("uses one restrained accent span to mark the product promise", async () => {
		const markup = renderToStaticMarkup(await LandingPage());
		const heading = markup.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? "";

		expect(heading).toContain("AI Image Editor");
		expect(heading).toContain('class="text-[#b79cff]"');
		expect(heading).toContain("With Prompts");
		expect(heading.match(/text-\[#b79cff\]/g)).toHaveLength(1);
	});
});

function createTranslator() {
	const messages: Record<string, string> = {
		"home.imageEditorHero.title": "AI Image Editor <accent>With Prompts</accent>",
	};
	const translate = (key: string) => messages[key] ?? key;
	translate.raw = () => ({ first: "Feature" });
	translate.rich = (key: string, values: { accent: (children: ReactNode) => ReactNode }) => {
		const message = messages[key] ?? key;
		const match = message.match(/^(.*?)<accent>(.*?)<\/accent>(.*)$/);
		return match ? [match[1], values.accent(match[2]), match[3]] : message;
	};
	return translate;
}
