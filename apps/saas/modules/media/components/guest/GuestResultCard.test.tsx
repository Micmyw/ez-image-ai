import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		({
			oneOutput: "One output",
			temporary: "Watermarked · available for up to 24 hours",
			temporaryCompact: "Watermarked · temporary",
			resultPlaceholder: "Your watermarked result will appear here.",
		})[key] ?? key,
}));

import { GuestResultCard } from "./GuestResultCard";

describe("GuestResultCard", () => {
	it("keeps the mobile result header compact while preserving result meaning", () => {
		const markup = renderToStaticMarkup(
			<GuestResultCard
				view={{ state: "preparingSession" }}
				resultUrl={null}
				onDownload={vi.fn()}
			/>,
		);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(visibleText).toContain("One output");
		expect(visibleText).toContain("Watermarked · temporary");
		expect(visibleText).toContain("Your watermarked result will appear here.");
		expect(visibleText).not.toContain("available for up to 24 hours");
	});
});
