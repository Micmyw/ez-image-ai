import { describe, expect, it } from "vitest";

import { imagePassCoversSku } from "./image-pass-eligibility";

describe("image pass size eligibility in the generation form", () => {
	it("uses the current 1K/2K offer when the balance has no size list", () => {
		expect(imagePassCoversSku(undefined, "nano-banana-2-2k")).toBe(true);
		expect(imagePassCoversSku(undefined, "nano-banana-2-4k")).toBe(false);
		expect(imagePassCoversSku({ availableSkuKeys: [] }, "nano-banana-pro-1k")).toBe(false);
	});
	it("follows the sizes frozen on the owner's available grants", () => {
		const restricted = { availableSkuKeys: ["nano-banana-2-1k", "nano-banana-2-2k"] };
		expect(imagePassCoversSku(restricted, "nano-banana-2-2k")).toBe(true);
		expect(imagePassCoversSku(restricted, "nano-banana-2-4k")).toBe(false);
		// A grandfathered pre-restriction grant still covers 4K.
		const legacy = { availableSkuKeys: ["nano-banana-2-2k", "nano-banana-2-4k"] };
		expect(imagePassCoversSku(legacy, "nano-banana-2-4k")).toBe(true);
	});
	it("rejects non-string selections", () => {
		expect(imagePassCoversSku({ availableSkuKeys: ["x"] }, undefined)).toBe(false);
	});
});
