import { describe, expect, it } from "vitest";

import { getImagePurposeShortcuts } from "./image-purpose-shortcuts";

describe("image purpose shortcuts", () => {
	it("includes the active SVG surcharge and GIF frame price in the shortcut cost", () => {
		const products = [
			{
				key: "image-gpt-image-2-6-flare",
				label: "Flare",
				skuMatrix: {
					cells: [
						{
							skuKey: "gpt-image-2-6-flare-1k",
							credits: 20,
							controls: [
								{
									key: "outputFormat",
									defaultValue: "png",
									options: ["png", "svg", "gif"].map((key) => ({ key })),
								},
							],
						},
					],
				},
			},
		];
		expect(getImagePurposeShortcuts(products, { outputFormat: "svg" })[0]?.credits).toBe(40);
		expect(
			getImagePurposeShortcuts(products, { outputFormat: "gif", frameCount: 16 })[0]?.credits,
		).toBe(80);
	});
	it("offers only public exact SKU matches with the catalog's actual cost", () => {
		const choices = getImagePurposeShortcuts([
			{
				key: "image-minimax-h3",
				label: "H3",
				skuMatrix: { cells: [{ skuKey: "minimax-h3-4k", credits: 20 }] },
			},
			{
				key: "image-nano-banana-2-lite",
				label: "Nano",
				skuMatrix: { cells: [{ skuKey: "nano-banana-2-lite-1k", credits: 5 }] },
			},
			{
				key: "image-gpt-image-2-6-flare",
				label: "Flare",
				skuMatrix: { cells: [{ skuKey: "gpt-image-2-6-flare-1k", credits: 23 }] },
			},
		]);
		expect(choices).toEqual([
			{
				key: "everyday",
				productKey: "image-nano-banana-2-lite",
				skuKey: "nano-banana-2-lite-1k",
				modelLabel: "Nano",
				credits: 5,
			},
			{
				key: "layouts",
				productKey: "image-gpt-image-2-6-flare",
				skuKey: "gpt-image-2-6-flare-1k",
				modelLabel: "Flare",
				credits: 23,
			},
		]);
	});
	it("does not invent a choice or price for an unavailable catalog entry", () => {
		expect(getImagePurposeShortcuts([])).toEqual([]);
		expect(getImagePurposeShortcuts([{ key: "image-minimax-h3", label: "H3" }])).toEqual([]);
		expect(
			getImagePurposeShortcuts([
				{
					key: "image-minimax-h3",
					label: "H3",
					skuMatrix: { cells: [{ skuKey: "minimax-h3-1k", credits: NaN }] },
				},
			]),
		).toEqual([]);
	});
});
