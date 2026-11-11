import { describe, expect, it } from "vitest";

import { getImageGenerationCredits } from "./image-generation-pricing";
import { parseImageSelection } from "./image-product-contract";

const product = "image-gpt-image-2-6-flare";
const selection = { skuKey: "gpt-image-2-6-flare-1k", aspectRatio: "1:1" } as const;

describe("GPT Image 2.6 format selection and fixed credit prices", () => {
	it.each([
		[2, 40],
		[8, 40],
		[9, 45],
		[10, 60],
		[12, 60],
		[13, 80],
		[16, 80],
	])("quotes %s frames at %s credits", (frameCount, credits) => {
		expect(getImageGenerationCredits({ ...selection, outputFormat: "gif", frameCount })).toBe(
			credits,
		);
	});
	it("keeps raster defaults and adds a separate SVG authoring price", () => {
		expect(getImageGenerationCredits(selection)).toBe(20);
		expect(getImageGenerationCredits({ ...selection, outputFormat: "svg" })).toBe(40);
		expect(getImageGenerationCredits({ skuKey: "gpt-image-2-5-flare-1k" })).toBe(7);
	});
	it("normalizes GIF defaults without adding GIF fields to raster requests", () => {
		expect(parseImageSelection(product, { ...selection, outputFormat: "gif" })).toMatchObject({
			frameCount: 9,
			frameDurationMs: 200,
		});
		expect(parseImageSelection(product, selection)).toEqual(selection);
	});
	it.each([
		{ outputFormat: "gif", frameCount: 64 },
		{ outputFormat: "gif", frameCount: 1 },
		{ outputFormat: "gif", frameCount: 2.5 },
		{ outputFormat: "gif", frameDurationMs: 201 },
		{ outputFormat: "gif", frameDurationMs: 0 },
		{ outputFormat: "gif", aspectRatio: "16:9" },
		{ outputFormat: "gif", skuKey: "gpt-image-2-6-flare-2k" },
		{ outputFormat: "svg", frameCount: 9 },
		{ outputFormat: "png", frameDurationMs: 200 },
		{ outputFormat: "jpeg", background: "transparent" },
		{ outputFormat: "svg", background: "transparent" },
		{ outputFormat: "gif", background: "transparent" },
	])("rejects incompatible settings before quoting: %j", (invalid) => {
		expect(parseImageSelection(product, { ...selection, ...invalid })).toBeNull();
	});
	it("does not widen legacy models to new output formats or frame parameters", () => {
		const old = { skuKey: "nano-banana-default", aspectRatio: "1:1" };
		for (const extra of [{ outputFormat: "svg" }, { outputFormat: "gif" }, { frameCount: 9 }]) {
			expect(parseImageSelection("image-nano-banana", { ...old, ...extra })).toBeNull();
		}
	});
});
