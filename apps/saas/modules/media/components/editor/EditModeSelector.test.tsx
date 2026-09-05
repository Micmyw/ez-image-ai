import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) =>
		({
			label: "Edit mode",
			standard: "Standard Edit",
			standardDescription: "Fast private edits",
			quality: "Quality Edit",
			qualityDescription: "More detailed private edits",
			credits:
				typeof values?.credits === "number" || typeof values?.credits === "string"
					? `${values.credits} credits`
					: "credits",
			qualityUnavailable: "Upgrade to use Quality Edit",
			upgrade: "View upgrade options",
		})[key] ?? key,
}));

import { EditModeSelector } from "./EditModeSelector";

describe("EditModeSelector", () => {
	it("keeps Quality selectable for upgrade without exposing internal catalog details", () => {
		const markup = renderToStaticMarkup(
			<EditModeSelector
				value="image-fast"
				onChange={vi.fn()}
				onUpgrade={vi.fn()}
				products={[
					{ key: "image-fast", credits: 5 },
					{ key: "image-quality", credits: 40 },
				]}
				allowedProductKeys={["image-fast"]}
			/>,
		);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(visibleText).toContain("Standard Edit");
		expect(visibleText).toContain("Quality Edit");
		expect(visibleText).toContain("Upgrade to use Quality Edit");
		expect(markup).toContain('role="radiogroup"');
		const qualityInput = markup.match(/<input[^>]*value="image-quality"[^>]*\/>/)?.[0];
		expect(qualityInput).not.toContain("disabled");
		expect(markup).toContain("<button");
		expect(markup).not.toContain('href="/settings/billing"');
		expect(visibleText).not.toMatch(/video|text-to-image|provider|model|image-fast|image-quality/i);
	});
});
