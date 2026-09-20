import { afterEach, describe, expect, it, vi } from "vitest";

import { replaceImageModelInUrl } from "./use-model-navigation";

afterEach(() => vi.unstubAllGlobals());

describe("image model URL selection", () => {
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
