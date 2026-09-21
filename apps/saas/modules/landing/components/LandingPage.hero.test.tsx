import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import englishMessages from "../../../../../packages/i18n/translations/en/marketing.json";

vi.mock("@shared/components/studio/StudioShell", () => ({
	StudioShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@repo/config/client", () => ({
	getPlanUsageEstimate: () => ({
		minimumImageEdits: 4,
		maximumImageEdits: 10,
		minimumCreditsPerImage: 5,
		maximumCreditsPerImage: 17,
	}),
	getPublicConfig: () => ({ brand: { siteName: "EzImageAI" } }),
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
vi.mock("../../models/components/ExploreModels", () => ({ ExploreModels: () => <section /> }));
vi.mock("../../public-content/components/PublicFooterLinks", () => ({
	PublicFooterLinks: () => null,
}));

import { LandingPage } from "./LandingPage";

describe("LandingPage hero hierarchy", () => {
	it("keeps the keyword heading and concise intro while explaining the meaning in the FAQ", async () => {
		const markup = renderToStaticMarkup(await LandingPage());
		const heading = markup.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? "";
		const headingText = heading.replace(/<[^>]*>/g, "");
		const hero = markup.match(/<section id="image-editor"[\s\S]*?<\/section>/)?.[0] ?? "";
		const faq = markup.match(/<section id="faq"[\s\S]*?<\/section>/)?.[0] ?? "";

		expect(headingText).toMatch(/ai image editor no restrictions/i);
		expect(heading).toContain('class="text-[#b79cff]"');
		expect(heading.match(/text-\[#b79cff\]/g)).toHaveLength(1);
		expect(hero).toContain("Upload an image and describe the change you want.");
		expect(hero.match(/<p(?:\s|>)/g)).toHaveLength(1);
		expect(faq).toMatch(/ai image editor with prompt no restrictions/i);
		expect(faq).toContain("flexible prompt editing");
		expect(faq).toContain("model capabilities, and plan limits still apply");
	});
});

function createTranslator() {
	const messages: Record<string, string> = {};
	function collect(value: unknown, path = "") {
		if (typeof value === "string") messages[path] = value;
		else if (value && typeof value === "object")
			for (const [key, child] of Object.entries(value))
				collect(child, path ? `${path}.${key}` : key);
	}
	collect(englishMessages);
	const translate = (key: string) => messages[key] ?? key;
	translate.raw = () => ({ first: "Feature" });
	translate.rich = (key: string, values: { accent: (children: ReactNode) => ReactNode }) => {
		const message = messages[key] ?? key;
		const match = message.match(/^(.*?)<accent>(.*?)<\/accent>(.*)$/);
		return match ? (
			<>
				{match[1]}
				{values.accent(match[2])}
				{match[3]}
			</>
		) : (
			message
		);
	};
	return translate;
}
