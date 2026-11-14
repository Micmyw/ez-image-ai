import { describe, expect, it } from "vitest";

import { currentImagePassOfferCoversSelection } from "./selected-image-pass-offer";

describe("new image pass offer coverage", () => {
	it.each([
		["image-nano-banana-pro", "nano-banana-pro-4k", undefined],
		["image-gpt-image-2-6-flare", "gpt-image-2-6-flare-1k", "svg"],
		["image-gpt-image-2-6-sunburst", "gpt-image-2-6-sunburst-1k", "gif"],
	] as const)(
		"covers %s %s %s through current frozen terms and the additive benefit",
		(productKey, skuKey, outputFormat) => {
			expect(currentImagePassOfferCoversSelection({ productKey, skuKey, outputFormat })).toBe(true);
		},
	);
	it.each([
		["image-minimax-h3", "minimax-h3-1k", undefined],
		["image-seedream-5-5", "seedream-5-5-2k", undefined],
		["image-minimax-h3", "nano-banana-pro-4k", undefined],
		["image-gpt-image-2-6-flare", "gpt-image-2-6-flare-4k", "gif"],
		["image-gpt-image-2-6-flare", "gpt-image-2-6-flare-1k", "webp"],
	] as const)(
		"does not advertise uncovered or mismatched %s %s %s",
		(productKey, skuKey, outputFormat) => {
			expect(currentImagePassOfferCoversSelection({ productKey, skuKey, outputFormat })).toBe(
				false,
			);
		},
	);
	it("requires a concrete selection independently of an owner's existing grants", () => {
		expect(currentImagePassOfferCoversSelection({})).toBe(false);
	});
});
