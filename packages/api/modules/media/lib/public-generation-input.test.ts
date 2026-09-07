import { describe, expect, it } from "vitest";

import {
	isValidCurrentEzPicImageSelection,
	publicImageGenerationInput,
} from "./public-generation-input";

describe("isValidCurrentEzPicImageSelection", () => {
	it("rejects the generic strength control that no current EzPic SKU declares", () => {
		expect(
			isValidCurrentEzPicImageSelection("image-gpt-image-2", {
				kind: "image-to-image",
				prompt: "Preserve the subject",
				sourceAssetId: "asset_abcdefghijklmnop",
				skuKey: "gpt-image-2-1k",
				aspectRatio: "1:1",
				strength: 0.42,
			}),
		).toBe(false);
	});
});

describe("publicImageGenerationInput", () => {
	it("projects the current GPT Image 2 1K default selection", () => {
		expect(
			publicImageGenerationInput("image-gpt-image-2", {
				kind: "image-to-image",
				prompt: "Preserve the subject",
				sourceAssetId: "asset-source",
				skuKey: "gpt-image-2-1k",
				aspectRatio: "1:1",
				background: "transparent",
			}),
		).toEqual({
			kind: "image-to-image",
			prompt: "Preserve the subject",
			sourceAssetId: "asset-source",
			skuKey: "gpt-image-2-1k",
			aspectRatio: "1:1",
			outputFormat: null,
			background: "transparent",
		});
	});

	it("returns a matrix-validated current SKU without copying unknown stored fields", () => {
		const result = publicImageGenerationInput("image-gpt-image-2", {
			kind: "image-to-image",
			prompt: "Preserve the subject",
			sourceAssetId: "asset-source",
			skuKey: "gpt-image-2-4k",
			aspectRatio: "4:5",
			providerModelId: "must-not-leak",
			providerCostMicros: 80_000,
			editContext: { private: true },
		});

		expect(result).toEqual({
			kind: "image-to-image",
			prompt: "Preserve the subject",
			sourceAssetId: "asset-source",
			skuKey: "gpt-image-2-4k",
			aspectRatio: "4:5",
			outputFormat: null,
			background: null,
		});
		expect(JSON.stringify(result)).not.toMatch(/provider|cost|editContext|private/i);
	});

	it("does not bless a non-billing control that is unavailable on the selected cell", () => {
		expect(
			publicImageGenerationInput("image-gpt-image-2", {
				kind: "image-to-image",
				prompt: "x",
				sourceAssetId: "asset-source",
				skuKey: "gpt-image-2-2k",
				aspectRatio: "1:1",
				background: "transparent",
			}),
		).toMatchObject({
			skuKey: null,
			aspectRatio: null,
			outputFormat: null,
			background: null,
		});
	});

	it("does not bless a SKU/product or aspect-ratio mismatch", () => {
		expect(
			publicImageGenerationInput("image-nano-banana-2-lite", {
				kind: "image-to-image",
				prompt: "x",
				sourceAssetId: "asset-source",
				skuKey: "gpt-image-2-4k",
				aspectRatio: "1:1",
			}),
		).toMatchObject({ skuKey: null, aspectRatio: null });
		expect(
			publicImageGenerationInput("image-gpt-image-2", {
				kind: "image-to-image",
				prompt: "x",
				sourceAssetId: "asset-source",
				skuKey: "gpt-image-2-4k",
				aspectRatio: "1:1",
			}),
		).toMatchObject({ skuKey: null, aspectRatio: null });
	});

	it("keeps legacy and non-image jobs from being presented as current SKUs", () => {
		expect(
			publicImageGenerationInput("image-fast", {
				kind: "image-to-image",
				prompt: "legacy",
				sourceAssetId: "asset-source",
				aspectRatio: "16:9",
			}),
		).toMatchObject({ skuKey: null, aspectRatio: null });
		expect(
			publicImageGenerationInput("video-fast", { kind: "text-to-video", prompt: "video" }),
		).toBeNull();
	});
});
