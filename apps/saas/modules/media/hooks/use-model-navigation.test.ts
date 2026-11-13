import { afterEach, describe, expect, it, vi } from "vitest";

import {
	imageModelHref,
	replaceImageModelInUrl,
	resolveRequestedImageModel,
	resolveRequestedImageOutputFormat,
} from "./use-model-navigation";

afterEach(() => vi.unstubAllGlobals());

describe("image model URL selection", () => {
	it("opens Seedream 5.5 with its dedicated image model", () => {
		expect(imageModelHref("image-seedream-5-5")).toBe("/seedream-5-5");
		expect(resolveRequestedImageModel("/seedream-5-5", null)).toBe("image-seedream-5-5");
		expect(resolveRequestedImageModel("/seedream-5-5", "unknown-model")).toBe("image-seedream-5-5");
		expect(resolveRequestedImageOutputFormat("/seedream-5-5")).toBeUndefined();
	});
	it("opens MiniMax H3 with its dedicated image model", () => {
		expect(imageModelHref("image-minimax-h3")).toBe("/minimax-h3-image");
		expect(resolveRequestedImageModel("/minimax-h3-image", null)).toBe("image-minimax-h3");
		expect(resolveRequestedImageModel("/minimax-h3-image", "unknown-model")).toBe(
			"image-minimax-h3",
		);
		expect(resolveRequestedImageOutputFormat("/minimax-h3-image")).toBeUndefined();
	});
	it("defaults the dedicated tools to a compatible model and output format", () => {
		for (const path of ["/gpt-image-2-6", "/ai-svg-generator", "/ai-gif-generator"]) {
			expect(resolveRequestedImageModel(path, null)).toBe("image-gpt-image-2-6-flare");
			expect(resolveRequestedImageModel(path, "image-gpt-image-2-6-sunburst")).toBe(
				"image-gpt-image-2-6-sunburst",
			);
		}
		expect(resolveRequestedImageOutputFormat("/ai-svg-generator")).toBe("svg");
		expect(resolveRequestedImageOutputFormat("/ai-gif-generator")).toBe("gif");
		expect(resolveRequestedImageOutputFormat("/create")).toBeUndefined();
		expect(resolveRequestedImageModel("/ai-svg-generator", "image-nano-banana-2-lite")).toBe(
			"image-gpt-image-2-6-flare",
		);
		expect(imageModelHref("image-gpt-image-2-6-sunburst")).toBe(
			"/gpt-image-2-6?model=image-gpt-image-2-6-sunburst",
		);
	});
	it("uses a valid model-page slug when an invalid query value tries to mask it", () => {
		expect(resolveRequestedImageModel("/models/nano-banana-2", "unknown-model")).toBe(
			"image-nano-banana-2",
		);
		expect(resolveRequestedImageModel("/create", "unknown-model")).toBe("unknown-model");
	});
	it("closes the previous result when choosing another model and preserves other URL options", () => {
		const replaceState = vi.fn();
		vi.stubGlobal("window", {
			location: {
				href: "https://ezpic.test/create?model=image-nano-banana-2-lite&job=history-1&lang=de#image-editor",
			},
			history: { replaceState },
		});

		replaceImageModelInUrl("image-gpt-image-2");

		expect(replaceState).toHaveBeenCalledWith(
			null,
			"",
			"/create?model=image-gpt-image-2&lang=de#image-editor",
		);
	});

	it("keeps a selected result when the model choice has not changed", () => {
		const replaceState = vi.fn();
		vi.stubGlobal("window", {
			location: { href: "https://ezpic.test/create?model=image-gpt-image-2&job=history-1" },
			history: { replaceState },
		});
		replaceImageModelInUrl("image-gpt-image-2");
		expect(replaceState).not.toHaveBeenCalled();
	});
});
