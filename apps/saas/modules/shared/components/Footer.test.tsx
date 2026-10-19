import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@config", () => ({
	config: { appName: "Configured Editor", supportEmail: "help@configured.test" },
}));
vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => (key: string) =>
		namespace === "feedback" && key === "footer"
			? "Feedback rewards"
			: key === "support"
				? "Help desk"
				: key,
}));

import { Footer } from "./Footer";

describe("SaaS footer", () => {
	it("uses the configured product identity and localized support label", () => {
		const markup = renderToStaticMarkup(<Footer />);

		expect(markup).toContain("Configured Editor");
		expect(markup).toContain("mailto:help@configured.test");
		expect(markup).toContain("Help desk");
		expect(markup).toContain("Feedback rewards");
		expect(markup).toContain('aria-haspopup="dialog"');
		expect(markup).not.toMatch(/supastarter/i);
	});
});
