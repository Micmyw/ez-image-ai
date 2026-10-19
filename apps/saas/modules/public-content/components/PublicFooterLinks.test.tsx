import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@config", () => ({ config: { supportEmail: "help@configured.test" } }));
vi.mock("next-intl", () => ({
	useLocale: () => "en",
	useTranslations: (namespace?: string) => (key: string) =>
		namespace === "feedback" && key === "footer" ? "Feedback rewards" : key,
}));
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
vi.mock("../lib/content", () => ({ getFeaturedPhotoIdeas: () => [] }));

import { PublicFooterLinks } from "./PublicFooterLinks";

describe("public feedback entry", () => {
	it("keeps feedback available beside the configured support email and public links", () => {
		const markup = renderToStaticMarkup(<PublicFooterLinks />);
		expect(markup).toContain("Feedback rewards");
		expect(markup).toContain('aria-haspopup="dialog"');
		expect(markup).toContain("mailto:help@configured.test");
		expect(markup).toContain('href="/contact#report-content"');
		expect(markup).not.toContain("<dialog");
	});
});
