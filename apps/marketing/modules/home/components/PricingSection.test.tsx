import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	delete process.env.PRICE_ID_CREATOR_MONTHLY;
	delete process.env.PRICE_ID_CREATOR_YEARLY;
	delete process.env.PRICE_ID_STUDIO_MONTHLY;
	delete process.env.PRICE_ID_STUDIO_YEARLY;
});

vi.mock("@config", () => ({ config: { saasUrl: "https://app.configured.test" } }));
vi.mock("@i18n/routing", () => ({
	LocaleLink: ({ children, href }: { children: React.ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
vi.mock("next-intl", () => ({
	useFormatter: () => ({ number: (value: number) => `$${value}` }),
	useTranslations: () => {
		const messages: Record<string, string> = {
			"pricing.products.free.title": "Free",
			"pricing.products.creator.title": "Creator",
			"pricing.products.studio.title": "Studio",
			"pricing.products.enterprise.title": "Enterprise",
			"pricing.checkoutUnavailable": "Paid checkout is temporarily unavailable.",
		};
		return Object.assign(
			(key: string, values?: Record<string, number>) => {
				if (key === "pricing.monthlyCredits") return `Localized credits ${values?.credits}`;
				if (key === "pricing.monthlyEditAllowance")
					return `Localized edits ${values?.standard}/${values?.quality}`;
				if (key === "pricing.monthlyStandardAllowance")
					return `Localized Standard edits ${values?.standard}`;
				if (key === "pricing.creditExpiry") return "Localized monthly expiry";
				if (key === "pricing.concurrentEdits") return `Localized concurrency ${values?.count}`;
				if (key === "pricing.maximumInputSize") return `Localized size ${values?.megabytes}`;
				return messages[key] ?? key;
			},
			{ raw: () => ({}) },
		);
	},
}));

import {
	isMarketingCheckoutAvailable,
	type MarketingCheckoutAvailability,
	PricingSection,
} from "./PricingSection";

const configuredCheckout: MarketingCheckoutAvailability = {
	creator: { month: true, year: true },
	studio: { month: true, year: false },
};

describe("EzPic pricing section", () => {
	it("renders only the free, creator, and studio product plans", () => {
		const markup = renderToStaticMarkup(<PricingSection />);

		expect(markup).toContain(">Free<");
		expect(markup).toContain(">Creator<");
		expect(markup).toContain(">Studio<");
		expect(markup).not.toContain(">Enterprise<");
		expect(markup.match(/data-test="price-table-plan"/g)).toHaveLength(3);
		for (const credits of [25, 700, 3_000]) {
			expect(markup).toContain(`Localized credits ${credits}`);
		}
		for (const allowance of [
			"Localized Standard edits 5",
			"Localized edits 140/17",
			"Localized edits 600/75",
		]) {
			expect(markup).toContain(allowance);
		}
		expect(markup.match(/Localized monthly expiry/g)).toHaveLength(3);
		for (const concurrency of [1, 3, 10]) {
			expect(markup).toContain(`Localized concurrency ${concurrency}`);
		}
		expect(markup).toContain("Localized size 10");
		expect(markup.match(/Localized size 20/g)).toHaveLength(2);
		expect(markup).not.toMatch(/Localized size (?:100|250)/);
		expect(markup).not.toContain("credits per month");
	});

	it("fails paid calls to action closed when Stripe Price IDs are unavailable", () => {
		const markup = renderToStaticMarkup(<PricingSection />);

		expect(markup.match(/href="https:\/\/app\.configured\.test\/signup"/g)).toHaveLength(1);
		expect(markup.match(/aria-disabled="true"/g)).toHaveLength(2);
		expect(markup.match(/Paid checkout is temporarily unavailable\./g)).toHaveLength(2);
	});

	it("uses only the server-projected interval availability to enable a paid CTA", () => {
		expect(isMarketingCheckoutAvailable("creator", "month", configuredCheckout)).toBe(true);
		expect(isMarketingCheckoutAvailable("studio", "year", configuredCheckout)).toBe(false);
		expect(isMarketingCheckoutAvailable("unknown", "month", configuredCheckout)).toBe(false);
	});
});
