import { describe, expect, it } from "vitest";

import { canConfirmEditorUpgrade, resolveEditorProductSelection } from "./editor-entitlement";

describe("editor product selection", () => {
	it("preserves GPT Image 2 and requests an upgrade when the current plan does not allow it", () => {
		expect(
			resolveEditorProductSelection("image-gpt-image-2", ["image-nano-banana-2-lite"]),
		).toEqual({
			productKey: "image-gpt-image-2",
			upgradeRequired: true,
		});
	});

	it("selects an entitled Seedream model without opening an upgrade", () => {
		expect(
			resolveEditorProductSelection("image-seedream-5-pro", [
				"image-nano-banana-2-lite",
				"image-seedream-5-pro",
			]),
		).toEqual({ productKey: "image-seedream-5-pro", upgradeRequired: false });
	});

	it("shows upgrade success only when the restored paid model is now entitled", () => {
		expect(canConfirmEditorUpgrade("image-gpt-image-2", ["image-nano-banana-2-lite"])).toBe(false);
		expect(
			canConfirmEditorUpgrade("image-gpt-image-2", [
				"image-nano-banana-2-lite",
				"image-gpt-image-2",
			]),
		).toBe(true);
	});
});
