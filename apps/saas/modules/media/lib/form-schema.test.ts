import { describe, expect, it } from "vitest";

import {
	buildGenerationInput,
	generationFieldSchema,
	generationFormValuesSchema,
} from "./form-schema";

describe("generation form schema", () => {
	it.each(["text", "select", "slider", "aspect-ratio", "count", "image-asset", "video-asset"])(
		"accepts the supported %s field",
		(type) =>
			expect(
				generationFieldSchema.safeParse({ type, key: "prompt", label: "Prompt" }).success,
			).toBe(true),
	);

	it("rejects fields outside the finite public schema", () => {
		expect(
			generationFieldSchema.safeParse({ type: "provider", key: "provider", label: "Provider" })
				.success,
		).toBe(false);
	});

	it("builds only an image-to-image edit input", () => {
		expect(
			buildGenerationInput({
				kind: "image-to-image",
				prompt: "  Replace the background  ",
				sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
				skuKey: "nano-banana-2-2k",
				aspectRatio: "16:9",
				outputFormat: "png",
				strength: 0.7,
			}),
		).toEqual({
			kind: "image-to-image",
			prompt: "Replace the background",
			sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
			skuKey: "nano-banana-2-2k",
			aspectRatio: "16:9",
			outputFormat: "png",
			strength: 0.7,
		});
	});

	it("preserves legal cell controls and rejects private routing fields", () => {
		expect(
			buildGenerationInput({
				kind: "image-to-image",
				prompt: "Make the background transparent",
				sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
				skuKey: "gpt-image-2-1k",
				aspectRatio: "1:1",
				background: "transparent",
			}),
		).toMatchObject({
			skuKey: "gpt-image-2-1k",
			background: "transparent",
		});

		expect(() =>
			buildGenerationInput({
				kind: "image-to-image",
				prompt: "Do not accept browser routing",
				sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
				skuKey: "gpt-image-2-1k",
				aspectRatio: "1:1",
				provider: "kie",
				providerModelId: "private-model-id",
			}),
		).toThrow();
	});

	it("accepts the expanded ratio union and leaves per-SKU validation to the server", () => {
		expect(
			buildGenerationInput({
				kind: "image-to-image",
				prompt: "Use a tall crop",
				sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
				skuKey: "nano-banana-2-lite-1k",
				aspectRatio: "4:5",
			}),
		).toMatchObject({ skuKey: "nano-banana-2-lite-1k", aspectRatio: "4:5" });
	});

	it.each(["text-to-image", "text-to-video", "image-to-video"] as const)(
		"rejects the non-editor %s input kind",
		(kind) => {
			expect(() =>
				buildGenerationInput({
					kind,
					prompt: "Do not expose this workflow",
					sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
				}),
			).toThrow();
		},
	);

	it("requires a source image and stable SKU for every public image model", () => {
		for (const [productKey, skuKey, aspectRatio] of [
			["image-nano-banana-2-lite", "nano-banana-2-lite-1k", "auto"],
			["image-gpt-image-2", "gpt-image-2-2k", "1:1"],
			["image-seedream-5-pro", "seedream-5-pro-basic-1k", "1:1"],
		] as const) {
			expect(
				generationFormValuesSchema.parse({
					productKey,
					skuKey,
					prompt: "  Studio portrait  ",
					sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
					aspectRatio,
				}),
			).toMatchObject({ productKey, skuKey, prompt: "Studio portrait", aspectRatio });
		}

		expect(() =>
			generationFormValuesSchema.parse({
				productKey: "image-nano-banana-2-lite",
				skuKey: "nano-banana-2-lite-1k",
				prompt: "Missing source image",
			}),
		).toThrow();
	});

	it("rejects video products before quote creation", () => {
		expect(() =>
			generationFormValuesSchema.parse({
				productKey: "video-fast",
				prompt: "Animate this image",
				aspectRatio: "1:1",
				durationSeconds: 5,
				sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
			}),
		).toThrow();
	});

	it("enforces the same required and maximum prompt boundary used by the server", () => {
		expect(() =>
			generationFormValuesSchema.parse({
				productKey: "image-nano-banana-2-lite",
				skuKey: "nano-banana-2-lite-1k",
				prompt: " ",
				sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
			}),
		).toThrow();
		expect(() =>
			generationFormValuesSchema.parse({
				productKey: "image-nano-banana-2-lite",
				skuKey: "nano-banana-2-lite-1k",
				prompt: "x".repeat(10_001),
				sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
			}),
		).toThrow();
	});
});
