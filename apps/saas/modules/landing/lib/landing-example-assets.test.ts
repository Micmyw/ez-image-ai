import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import artworkVariants from "./landing-artwork-variants.json";

const publicRoot = path.resolve(import.meta.dirname, "../../../public");
const vectorAssets = [
	"examples/studio-before.svg",
	"examples/studio-after.svg",
	"examples/edit-background.svg",
	"examples/edit-object.svg",
	"examples/edit-color.svg",
	"examples/edit-lighting.svg",
	"examples/edit-style.svg",
] as const;

const generatedAssets = [
	"examples/case-mediterranean-room.webp",
	"examples/case-cobalt-product.webp",
	"examples/case-emerald-fashion.webp",
	"examples/case-blue-hour.webp",
	"examples/case-citrus-editorial.webp",
	"examples/case-paper-train.webp",
	"examples/case-lunar-greenhouse.webp",
	"examples/case-porcelain-tide.webp",
	"examples/case-tangerine-camera.webp",
	"examples/case-velvet-fox.webp",
	"examples/case-origami-koi.webp",
	"examples/case-desert-pool.webp",
] as const;

describe("landing visual example assets", () => {
	it("ships correctly sized, content-versioned thumbnails for every homepage image", async () => {
		const expectedSources = [
			...generatedAssets.map((src) => `/${src}`),
			...["gpt-2-moon-cinema", "nano-pro-glass-perfume", "seedream-lite-kingfisher"].map(
				(key) => `/images/models/${key}.webp`,
			),
		];
		expect(Object.keys(artworkVariants).sort()).toEqual(expectedSources.sort());
		for (const [src, image] of Object.entries(artworkVariants)) {
			const source = readFileSync(path.join(publicRoot, src));
			expect(createHash("sha256").update(source).digest("hex"), src).toBe(image.sourceHash);
			for (const variant of image.variants) {
				const bytes = readFileSync(path.join(publicRoot, variant.src));
				const metadata = await sharp(bytes).metadata();
				expect(metadata.format, variant.src).toBe("webp");
				expect(metadata.width, variant.src).toBe(variant.width);
				expect(
					Math.abs(metadata.height! - (variant.width * image.height) / image.width),
				).toBeLessThanOrEqual(0.5);
				expect(variant.src).toContain(
					`.${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.webp`,
				);
				if (variant.width <= 384) expect(bytes.length, variant.src).toBeLessThan(40 * 1024);
			}
		}
	});

	it.each(vectorAssets)("ships %s with the unified SaaS application", (relativePath) => {
		const assetPath = path.join(publicRoot, relativePath);
		expect(existsSync(assetPath)).toBe(true);
		expect(readFileSync(assetPath, "utf8")).toContain("<svg");
	});

	it.each(generatedAssets)("ships an optimized WebP case at %s", (relativePath) => {
		const assetPath = path.join(publicRoot, relativePath);
		expect(existsSync(assetPath)).toBe(true);
		expect(statSync(assetPath).size).toBeLessThan(250_000);
		const header = readFileSync(assetPath).subarray(0, 12);
		expect(header.subarray(0, 4).toString("ascii")).toBe("RIFF");
		expect(header.subarray(8, 12).toString("ascii")).toBe("WEBP");
	});
});
