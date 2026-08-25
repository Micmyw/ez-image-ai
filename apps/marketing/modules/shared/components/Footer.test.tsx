import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@config", () => ({
	config: { appName: "EzPic", supportEmail: "help@configured.test" },
}));
vi.mock("@i18n/routing", () => ({
	LocaleLink: ({ children, href }: { children: React.ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
vi.mock("@repo/ui", () => ({
	Logo: ({ label }: { label?: string }) => <span data-logo-label={label} />,
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		({
			"common.menu.examples": "Examples",
			"common.menu.howItWorks": "How It Works",
			"common.menu.pricing": "Pricing",
			"common.menu.faq": "FAQ",
			"common.footer.privacyPolicy": "Privacy policy",
			"common.footer.termsAndConditions": "Terms and conditions",
			"common.footer.support": "Support",
			"common.footer.builtWith": "Built with supastarter",
		})[key] ?? key,
}));

import { Footer } from "./Footer";

describe("marketing footer", () => {
	it("renders EzPic product, legal, and configured support links without template branding", () => {
		const markup = renderToStaticMarkup(<Footer />);

		for (const label of [
			"Examples",
			"How It Works",
			"Pricing",
			"FAQ",
			"Privacy policy",
			"Terms and conditions",
			"Support",
		]) {
			expect(markup).toContain(label);
		}
		expect(markup).toContain('href="mailto:help@configured.test"');
		expect(markup).toContain('href="/privacy"');
		expect(markup).toContain('href="/terms"');
		expect(markup).not.toMatch(/href="\/legal\/(?:privacy-policy|terms)"/);
		expect(markup).toContain('data-logo-label="EzPic"');
		expect(markup).not.toMatch(/supastarter|built with/i);
	});
});
