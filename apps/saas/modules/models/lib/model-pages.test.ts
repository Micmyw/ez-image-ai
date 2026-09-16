import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { ExploreModels } from "../components/ExploreModels";
import { ModelRecommendations } from "../components/ModelRecommendations";
import { INSPIRATION } from "./model-artwork";
import artworkVariants from "./model-artwork-variants.json";
import { MODEL_PAGES, modelPath, modelRecommendations } from "./model-pages";

describe("model artwork", () => {
	it("renders three complete image recommendation links for every model", () => {
		for (const model of MODEL_PAGES) {
			const html = renderToStaticMarkup(createElement(ModelRecommendations, { model }));
			const cards = html.match(/<a class="model-related-card"[\s\S]*?<\/a>/g) ?? [];
			const recommendations = modelRecommendations(model);
			expect(cards, model.name).toHaveLength(3);
			for (const [index, card] of cards.entries()) {
				const recommendation = recommendations[index]!;
				expect(card, model.name).toContain("<img ");
				expect(card, model.name).toContain("<h3");
				expect(card, model.name).toContain("<p>");
				expect(card, model.name).toContain(`href="${modelPath(recommendation.model.key)}"`);
				expect(card, model.name).toContain(`/images/models/variants/${recommendation.artwork}-`);
				expect(card, model.name).not.toContain(`href="${modelPath(model.key)}"`);
			}
		}
	});

	it("serves displayed artwork without a runtime image optimizer", () => {
		const html = renderToStaticMarkup(createElement(ExploreModels));
		expect(html).not.toContain("/_next/image");
		expect(html).toContain('srcSet="/images/landing/variants/');
		expect(html).toContain('media="(min-width: 768px)"');
		expect(html.match(/width="1536" height="1024"/g)).toHaveLength(3);
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

	it("gives every model its own cover and three complete recommendation portraits", () => {
		expect(new Set(MODEL_PAGES.map((model) => model.artwork)).size).toBe(MODEL_PAGES.length);
		for (const model of MODEL_PAGES) {
			expect(model.recommendationArtwork, model.name).toHaveLength(3);
			for (const key of model.recommendationArtwork) {
				expect(INSPIRATION[key].height, key).toBeGreaterThan(INSPIRATION[key].width);
			}
		}
	});

	it("uses each destination model's portraits once across all referring pages", () => {
		const displayed = [];
		for (const page of MODEL_PAGES) {
			const recommendations = modelRecommendations(page);
			expect(recommendations, page.name).toHaveLength(3);
			expect(new Set(recommendations.map(({ model }) => model.key)).size).toBe(3);
			for (const { model, artwork } of recommendations) {
				expect(model.key).not.toBe(page.key);
				expect(model.family).toBe(page.family);
				expect(model.recommendationArtwork).toContain(artwork);
				displayed.push(artwork);
			}
		}
		expect(displayed).toHaveLength(MODEL_PAGES.length * 3);
		expect(new Set(displayed).size).toBe(displayed.length);
		expect(displayed.sort()).toEqual(
			MODEL_PAGES.flatMap((model) => model.recommendationArtwork).sort(),
		);
	});

	it("uses separate files and image content for all detail-page artwork", () => {
		const keys = MODEL_PAGES.flatMap((model) => [
			model.artwork,
			model.exampleArtwork,
			...(model.beforeArtwork ? [model.beforeArtwork] : []),
			...model.recommendationArtwork,
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
