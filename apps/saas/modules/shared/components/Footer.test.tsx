import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@config", () => ({
	config: { appName: "Configured Editor", supportEmail: "help@configured.test" },
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => (key === "support" ? "Help desk" : key),
}));

import { Footer } from "./Footer";

describe("SaaS footer", () => {
	it("uses the configured product identity and localized support label", () => {
		const markup = renderToStaticMarkup(<Footer />);

		expect(markup).toContain("Configured Editor");
		expect(markup).toContain("mailto:help@configured.test");
		expect(markup).toContain("Help desk");
		expect(markup).not.toMatch(/supastarter/i);
	});
});
