import { describe, expect, it } from "vitest";

import { canConfirmEditorUpgrade, resolveEditorProductSelection } from "./editor-entitlement";

describe("editor product selection", () => {
	it("preserves Quality and requests an upgrade when the current plan does not allow it", () => {
		expect(resolveEditorProductSelection("image-quality", ["image-fast"])).toEqual({
			productKey: "image-quality",
			upgradeRequired: true,
		});
	});

	it("selects an entitled edit mode without opening an upgrade", () => {
		expect(resolveEditorProductSelection("image-quality", ["image-fast", "image-quality"])).toEqual(
			{ productKey: "image-quality", upgradeRequired: false },
		);
	});

	it("shows upgrade success only when the restored Quality mode is now entitled", () => {
		expect(canConfirmEditorUpgrade("image-quality", ["image-fast"])).toBe(false);
		expect(canConfirmEditorUpgrade("image-quality", ["image-fast", "image-quality"])).toBe(true);
	});
});
