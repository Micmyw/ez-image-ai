import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { ExploreModels } from "../components/ExploreModels";
import { INSPIRATION } from "./model-artwork";
import artworkVariants from "./model-artwork-variants.json";
import { MODEL_PAGES } from "./model-pages";

describe("model artwork", () => {
	it("serves displayed artwork without a runtime image optimizer", () => {
		const html = renderToStaticMarkup(createElement(ExploreModels));
		expect(html).not.toContain("/_next/image");
		expect(html).toContain('srcSet="/images/models/variants/');
		expect(html.match(/<img /g)).toHaveLength(3);
	});

	it("ships complete responsive artwork with accurate dimensions and immutable URLs", async () => {
		expect(Object.keys(artworkVariants).sort()).toEqual(Object.keys(INSPIRATION).sort());
		for (const [key, image] of Object.entries(artworkVariants)) {
			const source = readFileSync(
				new URL(`../../../public/images/models/${key}.webp`, import.meta.url),
			);
			const sourceHash = createHash("sha256").update(source).digest("hex");
			expect(image.sourceHash, key).toBe(sourceHash);
			const original = await sharp(source).metadata();
			expect([image.width, image.height], key).toEqual([original.width, original.height]);
			expect(image.variants.length, key).toBeGreaterThan(1);
			expect(image.variants.at(-1)!.width, key).toBe(image.width);
			let previousWidth = 0;
			for (const variant of image.variants) {
				const bytes = readFileSync(new URL(`../../../public${variant.src}`, import.meta.url));
				const hash = createHash("sha256").update(bytes).digest("hex");
				expect(variant.src).toBe(
					`/images/models/variants/${key}-${variant.width}.${hash.slice(0, 16)}.webp`,
				);
				const metadata = await sharp(bytes).metadata();
				expect(metadata.format, variant.src).toBe("webp");
				expect(metadata.width, variant.src).toBe(variant.width);
				expect(variant.width).toBeGreaterThan(previousWidth);
				expect(variant.width).toBeLessThanOrEqual(image.width);
				expect(
					Math.abs(metadata.height! - (variant.width * image.height) / image.width),
					variant.src,
				).toBeLessThanOrEqual(0.5);
				if (variant.width === image.width) expect(hash, key).toBe(sourceHash);
				previousWidth = variant.width;
			}
		}
	});

	it("gives every model its own cover", () => {
		expect(new Set(MODEL_PAGES.map((model) => model.artwork)).size).toBe(MODEL_PAGES.length);
	});

	it("uses separate image files and content for covers, examples, and reference drawings", () => {
		const keys = MODEL_PAGES.flatMap((model) => [
			model.artwork,
			model.exampleArtwork,
			...(model.beforeArtwork ? [model.beforeArtwork] : []),
		]);
		expect(new Set(keys).size).toBe(keys.length);
		const fingerprints = keys.map((key) =>
			createHash("sha256")
				.update(readFileSync(new URL(`../../../public/images/models/${key}.webp`, import.meta.url)))
				.digest("hex"),
		);
		expect(new Set(fingerprints).size).toBe(keys.length);
	});
});
