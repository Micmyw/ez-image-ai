import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { mediaAssetIdSchema, mediaModelInputSchema, promptSchema } from "./schemas";

describe("moderated prompt length", () => {
	it.each(["a", "海", "😀"])("keeps the UTF-16 boundary for %s", (character) => {
		const maximum = character.repeat(10_000 / character.length);
		expect(promptSchema.safeParse(maximum).success).toBe(true);
		const oversized = promptSchema.safeParse(maximum + character);
		expect(oversized.success).toBe(false);
		if (!oversized.success)
			expect(oversized.error.issues).toContainEqual(expect.objectContaining({ code: "too_big" }));
	});
});

describe("persisted source asset identifiers", () => {
	it.each([randomUUID(), "cmty2q7jn0000psp796afssd6", "asset_01J5ABCD1234EFGH5678JKLMNP"])(
		"accepts upload, Prisma, and legacy asset identifier %s",
		(sourceAssetId) => {
			expect(
				mediaModelInputSchema.safeParse({
					kind: "image-to-image",
					sourceAssetId,
					prompt: "Change the camera color",
					skuKey: "nano-banana-2-lite-1k",
					aspectRatio: "auto",
				}).success,
			).toBe(true);
		},
	);
	it.each([
		"https://example.com/image.png",
		"../../other-user",
		"",
		"a".repeat(200),
		"asset_short",
	])("rejects non-asset identifier %s", (id) => {
		expect(mediaAssetIdSchema.safeParse(id).success).toBe(false);
	});
});
