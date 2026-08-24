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
				strength: 0.7,
			}),
		).toEqual({
			kind: "image-to-image",
			prompt: "Replace the background",
			sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
			strength: 0.7,
		});
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

	it("requires a source image for both public edit modes", () => {
		for (const productKey of ["image-fast", "image-quality"] as const) {
			expect(
				generationFormValuesSchema.parse({
					productKey,
					prompt: "  Studio portrait  ",
					sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
				}),
			).toMatchObject({ productKey, prompt: "Studio portrait" });
		}

		expect(() =>
			generationFormValuesSchema.parse({
				productKey: "image-fast",
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
				productKey: "image-fast",
				prompt: " ",
				sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
			}),
		).toThrow();
		expect(() =>
			generationFormValuesSchema.parse({
				productKey: "image-fast",
				prompt: "x".repeat(10_001),
				sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
			}),
		).toThrow();
	});
});
