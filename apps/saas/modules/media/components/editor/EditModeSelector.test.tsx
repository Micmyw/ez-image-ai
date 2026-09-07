import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) =>
		({
			label: "Image model",
			credits:
				typeof values?.credits === "number" || typeof values?.credits === "string"
					? `${values.credits} credits`
					: "credits",
			qualityUnavailable: "Upgrade to use this image model",
			upgrade: "View upgrade options",
		})[key] ?? key,
}));

import { EditModeSelector } from "./EditModeSelector";

describe("EditModeSelector", () => {
	it("keeps an unavailable paid model selectable without leaking internal routing details", () => {
		const markup = renderToStaticMarkup(
			<EditModeSelector
				value="image-gpt-image-2"
				onChange={vi.fn()}
				onUpgrade={vi.fn()}
				products={[
					{
						key: "image-nano-banana-2-lite",
						label: "Nano Banana 2 Lite",
						description: "Fast 1K image edits",
						credits: 5,
					},
					{
						key: "image-gpt-image-2",
						label: "GPT Image 2",
						description: "Detailed 1K, 2K, and 4K image edits",
						credits: 7,
					},
					{
						key: "image-seedream-5-pro",
						label: "Seedream 5 Pro",
						description: "Basic 1K and High 2K image edits",
						credits: 8,
					},
				]}
				allowedProductKeys={["image-nano-banana-2-lite"]}
			/>,
		);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(visibleText).toContain("Nano Banana 2 Lite");
		expect(visibleText).toContain("GPT Image 2");
		expect(visibleText).toContain("Seedream 5 Pro");
		expect(visibleText).toContain("Upgrade to use this image model");
		expect(markup).toContain('role="radiogroup"');
		const paidInput = markup.match(/<input[^>]*value="image-gpt-image-2"[^>]*\/>/)?.[0];
		expect(paidInput).toBeDefined();
		expect(paidInput).not.toContain("disabled");
		expect(markup).toContain("<button");
		expect(markup).not.toContain('href="/settings/billing"');
		expect(visibleText).not.toMatch(
			/video|text-to-image|provider|image-nano-banana-2-lite|image-gpt-image-2|image-seedream-5-pro|gpt-image-2-image-to-image|kie/i,
		);
	});
});
