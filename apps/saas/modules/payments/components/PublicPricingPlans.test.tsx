import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const translations: Record<string, string> = {
	"payments.providerSelector.providers.paypal": "PayPal",
	"payments.providerSelector.providers.waffo": "Waffo",
	"pricing.annualSummary":
		"Billed {total} yearly · save {savings} ({percent}%) vs 12 monthly payments",
	"pricing.annualTotal": "Billed {total} yearly",
	"pricing.aspectRatios": "Portrait, square, and landscape ratios",
	"pricing.baseCredits": "Base credits: {credits}",
	"pricing.buyWith": "Buy with {provider}",
	"pricing.capabilitiesLabel": "Editing capabilities",
	"pricing.concurrentEdits": "{count} concurrent edits",
	"pricing.creditExpiry": "Credits refresh monthly and unused credits do not roll over.",
	"pricing.creditPacks": "Credit Packs",
	"pricing.creditPackTitle": "{credits} Credits",
	"pricing.creditPackValidity": "Valid for {months} months",
	"pricing.editHistory": "Private edit history",
	"pricing.getStarted": "Get started",
	"pricing.maximumInputSize": "Source images up to {megabytes} MB",
	"pricing.month": "month",
	"pricing.monthly": "Monthly",
	"pricing.monthlyCredits": "{credits} credits per month",
	"pricing.monthlyFixedImageAllowance": "Up to {count} images per month at {credits} credits each",
	"pricing.monthlyImageAllowance":
		"About {minimum}–{maximum} images per month at {minimumCredits}–{maximumCredits} credits each",
	"pricing.oneTime": "one-time",
	"pricing.privateAssets": "Private assets",
	"pricing.products.creator.description": "For individual creators.",
	"pricing.products.creator.title": "Pro",
	"pricing.products.free.description": "Try the included 1K model.",
	"pricing.products.free.title": "Free",
	"pricing.products.studio.description": "For high-volume workflows.",
	"pricing.products.studio.title": "Max",
	"pricing.products.ultimate.description": "For growing creative workflows.",
	"pricing.products.ultimate.title": "Ultimate",
	"pricing.allImageModels": "All available image models",
	"pricing.nanoModel": "Nano Banana 2 Lite 1K",
	"pricing.recommended": "Recommended",
	"pricing.subscriberBonus": "Subscribers get +{percent}% credits at the same price",
	"pricing.subscriberBonusAmount": "Subscriber bonus: {credits}",
	"pricing.subscriberReceives": "Subscribers receive {credits} credits",
	"pricing.yearly": "Yearly",
};

function interpolate(message: string, values?: Record<string, number | string>) {
	return Object.entries(values ?? {}).reduce(
		(output, [key, value]) => output.replace(`{${key}}`, String(value)),
		message,
	);
}

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const translate = (key: string, values?: Record<string, number | string>) =>
			interpolate(translations[key] ?? key, values);
		translate.raw = (key: string) => {
			if (!key.endsWith(".features")) return undefined;
			return {
				editHistory: "Private edit history",
				privateAssets: "Private source images and edited assets",
			};
		};
		return translate;
	},
}));

vi.mock("next/link", () => ({
	default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
		<a href={String(href)} {...props}>
			{children}
		</a>
	),
}));

vi.mock("@repo/config/client", () => ({
	PLAN_ENTITLEMENTS: [
		{
			id: "free",
			allowedProducts: ["image-nano-banana-2-lite"],
			maximumConcurrentJobs: 1,
			maximumInputBytes: 10 * 1024 * 1024,
			monthlyCredits: 25,
			prices: [],
		},
		{
			id: "creator",
			allowedProducts: ["image-nano-banana-2-lite", "image-gpt-image-2", "image-seedream-5-pro"],
			maximumConcurrentJobs: 3,
			maximumInputBytes: 20 * 1024 * 1024,
			monthlyCredits: 700,
			prices: [
				{ amount: 19, currency: "USD", interval: "month" },
				{ amount: 190, currency: "USD", interval: "year" },
			],
		},
		{
			id: "ultimate",
			allowedProducts: ["image-nano-banana-2-lite", "image-gpt-image-2", "image-seedream-5-pro"],
			maximumConcurrentJobs: 6,
			maximumInputBytes: 20 * 1024 * 1024,
			monthlyCredits: 1800,
			prices: [
				{ amount: 49, currency: "USD", interval: "month" },
				{ amount: 490, currency: "USD", interval: "year" },
			],
		},
		{
			id: "studio",
			allowedProducts: ["image-nano-banana-2-lite", "image-gpt-image-2", "image-seedream-5-pro"],
			maximumConcurrentJobs: 10,
			maximumInputBytes: 20 * 1024 * 1024,
			monthlyCredits: 3000,
			prices: [
				{ amount: 79, currency: "USD", interval: "month" },
				{ amount: 790, currency: "USD", interval: "year" },
			],
		},
	],
	PUBLIC_CREDIT_PACKS: [
		{
			packKey: "credits-1500",
			baseCredits: 1500,
			subscriberCredits: 1800,
			subscriberBonusPercent: 20,
			price: { amount: 59, currency: "USD" },
			expiryMonths: 6,
		},
		{
			packKey: "credits-3000",
			baseCredits: 3000,
			subscriberCredits: 3600,
			subscriberBonusPercent: 20,
			price: { amount: 109, currency: "USD" },
			expiryMonths: 6,
		},
		{
			packKey: "credits-5000",
			baseCredits: 5000,
			subscriberCredits: 6000,
			subscriberBonusPercent: 20,
			price: { amount: 169, currency: "USD" },
			expiryMonths: 6,
		},
		{
			packKey: "credits-8000",
			baseCredits: 8000,
			subscriberCredits: 9600,
			subscriberBonusPercent: 20,
			price: { amount: 259, currency: "USD" },
			expiryMonths: 6,
		},
	],
	getPlanUsageEstimate: (planId: string) =>
		({
			free: {
				minimumImageEdits: 5,
				maximumImageEdits: 5,
				minimumCreditsPerImage: 5,
				maximumCreditsPerImage: 5,
			},
			creator: {
				minimumImageEdits: 41,
				maximumImageEdits: 140,
				minimumCreditsPerImage: 5,
				maximumCreditsPerImage: 17,
			},
			ultimate: {
				minimumImageEdits: 105,
				maximumImageEdits: 360,
				minimumCreditsPerImage: 5,
				maximumCreditsPerImage: 17,
			},
			studio: {
				minimumImageEdits: 176,
				maximumImageEdits: 600,
				minimumCreditsPerImage: 5,
				maximumCreditsPerImage: 17,
			},
		})[planId],
}));

vi.mock("@shared/hooks/router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			createCreditPackCheckout: { mutationOptions: () => ({}) },
			getCreditPackProviderAvailability: { queryOptions: () => ({}) },
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
	useQuery: () => ({
		data: {
			providers: [
				{ capabilities: { checkout: true }, name: "paypal" },
				{ capabilities: { checkout: true }, name: "waffo" },
			],
		},
		isError: false,
		isPending: false,
	}),
}));

import { PublicPricingPlans } from "./PublicPricingPlans";

describe("PublicPricingPlans", () => {
	it("opens on truthful yearly pricing with only Pro, Ultimate, and Max", () => {
		const markup = renderToStaticMarkup(<PublicPricingPlans locale="en-US" />);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(markup.match(/data-test="public-pricing-plan"/g)).toHaveLength(3);
		expect(markup).toContain('data-plan-id="creator"');
		expect(markup).toContain('data-plan-id="ultimate"');
		expect(markup).toContain('data-plan-id="studio"');
		expect(markup).not.toContain('data-plan-id="free"');
		expect(visibleText).toContain("Pro");
		expect(visibleText).toContain("Ultimate");
		expect(visibleText).toContain("Max");
		expect(visibleText).not.toMatch(/\bFree\b/);
		const yearlyButton = markup.match(
			/<button[^>]*data-test="public-pricing-interval-year"[^>]*>/,
		)?.[0];
		expect(yearlyButton).toContain('aria-pressed="true"');
		expect(visibleText).toContain("-17%");
		expect(visibleText).toContain("Billed $190 yearly");
		expect(markup).toMatch(/data-plan-id="ultimate"[^>]*data-recommended="true"/);
	});

	it("shows stable product capabilities without provider or cost details", () => {
		const markup = renderToStaticMarkup(<PublicPricingPlans locale="en-US" />);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(visibleText).toContain("Editing capabilities");
		expect(visibleText).toContain("Nano Banana 2 Lite 1K");
		expect(visibleText).toContain("All available image models");
		expect(visibleText).toContain("Private assets");
		expect(visibleText).toContain("Private edit history");
		expect(visibleText).toContain("Portrait, square, and landscape ratios");
		expect(visibleText).not.toMatch(
			/Standard Edit|Quality Edit|Kie|OpenRouter|providerModelId|providerCostMicros|gpt-image-2-image-to-image|seedream\/5-pro-image-to-image|\$0\.0/i,
		);
	});

	it("renders all four one-time credit packs with the subscriber bonus and only PayPal or Waffo", () => {
		const markup = renderToStaticMarkup(<PublicPricingPlans locale="en-US" />);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(visibleText).toContain("Credit Packs");
		expect(markup.match(/data-test="public-credit-pack"/g)).toHaveLength(4);
		expect(visibleText).toContain("Subscribers get +20% credits at the same price");
		for (const [base, total, price] of [
			["1,500", "1,800", "$59"],
			["3,000", "3,600", "$109"],
			["5,000", "6,000", "$169"],
			["8,000", "9,600", "$259"],
		]) {
			expect(visibleText).toContain(`Base credits: ${base}`);
			expect(visibleText).toContain(`Subscribers receive ${total} credits`);
			expect(visibleText).toContain(price);
		}
		expect(visibleText.match(/Buy with PayPal/g)).toHaveLength(4);
		expect(visibleText.match(/Buy with Waffo/g)).toHaveLength(4);
		expect(visibleText).toContain("Valid for 6 months");
		expect(visibleText).not.toMatch(/Stripe|credit or debit card/i);
	});
});
