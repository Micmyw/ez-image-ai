import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

import { SupportedEditsSection } from "./SupportedEditsSection";

describe("supported edits section", () => {
	it("describes the supported source-image edit directions without expanding the public catalog", () => {
		const markup = renderToStaticMarkup(<SupportedEditsSection />);

		expect(markup).toContain('id="supported-edits"');
		expect(markup).toContain("supportedEdits.title");
		for (const key of ["background", "objects", "color", "lighting", "style", "cleanup"]) {
			expect(markup).toContain(`supportedEdits.items.${key}.title`);
			expect(markup).toContain(`supportedEdits.items.${key}.description`);
		}
		expect(markup).not.toMatch(/video|text.to.image|unlimited|uncensored/i);
	});
});
