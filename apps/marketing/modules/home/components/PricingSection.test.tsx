import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
		};
		return Object.assign(
			(key: string, values?: Record<string, number>) => {
				if (key === "pricing.monthlyCredits") return `Localized credits ${values?.credits}`;
				if (key === "pricing.concurrentEdits") return `Localized concurrency ${values?.count}`;
				if (key === "pricing.maximumInputSize") return `Localized size ${values?.megabytes}`;
				return messages[key] ?? key;
			},
			{ raw: () => ({}) },
		);
	},
}));

import { PricingSection } from "./PricingSection";

describe("EzPic pricing section", () => {
	it("renders only the free, creator, and studio product plans", () => {
		const markup = renderToStaticMarkup(<PricingSection />);

		expect(markup).toContain(">Free<");
		expect(markup).toContain(">Creator<");
		expect(markup).toContain(">Studio<");
		expect(markup).not.toContain(">Enterprise<");
		expect(markup.match(/data-test="price-table-plan"/g)).toHaveLength(3);
		for (const credits of [25, 1_000, 5_000]) {
			expect(markup).toContain(`Localized credits ${credits}`);
		}
		for (const concurrency of [1, 3, 10]) {
			expect(markup).toContain(`Localized concurrency ${concurrency}`);
		}
		expect(markup).toContain("Localized size 10");
		expect(markup.match(/Localized size 20/g)).toHaveLength(2);
		expect(markup).not.toMatch(/Localized size (?:100|250)/);
		expect(markup).not.toContain("credits per month");
	});
});
