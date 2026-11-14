import { describe, expect, it } from "vitest";

import { IMAGE_TOOL_PAGES, getImageToolStarterPreset, type ImageToolPageKey } from "./tool-pages";

describe("tool starter preset", () => {
	it.each(Object.keys(IMAGE_TOOL_PAGES) as ImageToolPageKey[])(
		"seeds %s from a bounded existing example that needs no reference",
		(tool) => {
			const preset = getImageToolStarterPreset(tool);
			expect(preset?.prompt.trim()).toBeTruthy();
			expect(
				IMAGE_TOOL_PAGES[tool].prompts.some(
					(example) => !example.referenceImage && example.prompt === preset?.prompt,
				),
			).toBe(true);
			expect(preset?.skuKey).toBeTruthy();
		},
	);
	it("keeps format tools on the validated 1K SVG/GIF selection", () => {
		expect(getImageToolStarterPreset("ai-svg-generator")).toMatchObject({
			skuKey: "gpt-image-2-6-flare-1k",
			outputFormat: "svg",
		});
		expect(getImageToolStarterPreset("ai-gif-generator")).toMatchObject({
			skuKey: "gpt-image-2-6-flare-1k",
			outputFormat: "gif",
			aspectRatio: "1:1",
		});
	});
});
