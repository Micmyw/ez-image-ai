import { describe, expect, it } from "vitest";

import { imagePassCoversSku, imagePassIncludesSkuAccess } from "./image-pass-eligibility";

describe("image pass size eligibility in the generation form", () => {
	it("does not infer purchased coverage from the current public offer", () => {
		expect(imagePassCoversSku(undefined, "nano-banana-2-2k")).toBe(false);
		expect(imagePassCoversSku(undefined, "nano-banana-2-4k")).toBe(false);
		expect(imagePassCoversSku({ availableSkuKeys: [] }, "nano-banana-pro-1k")).toBe(false);
	});
	it("grants independent model access only from the server's available frozen grants", () => {
		const current = {
			availableSkuKeys: ["nano-banana-pro-4k", "gpt-image-1-5-high"],
			subscriptionFreeSkuKeys: ["nano-banana-pro-4k", "gpt-image-1-5-high"],
		};
		for (const sku of current.availableSkuKeys) {
			expect(imagePassCoversSku(current, sku)).toBe(true);
			expect(imagePassIncludesSkuAccess(current, sku)).toBe(true);
			expect(imagePassIncludesSkuAccess({ availableSkuKeys: current.availableSkuKeys }, sku)).toBe(
				false,
			);
			expect(imagePassIncludesSkuAccess({ ...current, availableSkuKeys: [] }, sku)).toBe(false);
			expect(imagePassIncludesSkuAccess({ ...current, subscriptionFreeSkuKeys: [] }, sku)).toBe(
				false,
			);
		}
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
