import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { parseImageSelection } from "@repo/config/client";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import origami from "../../../../../docs/operations/evidence/gpt-image-2-6-gif-2026-11-13.json";
import evidence from "../../../../../docs/operations/evidence/gpt-image-2-6-page-materials-2026-11-14.json";
import { GPT_IMAGE_2_6_EXAMPLES, GPT_IMAGE_2_6_ORIGAMI_EXAMPLE } from "./gpt-image-2-6-examples";
import { IMAGE_TOOL_PAGES } from "./tool-pages";

describe("separate GPT Image 2.6 showcases", () => {
	it.each(["flare", "sunburst"] as const)(
		"keeps %s prompts and settings tied to their source model",
		(variant) => {
			const supplied = evidence.examples.filter((example) => example.variant === variant);
			expect(supplied).toHaveLength(variant === "flare" ? 4 : 6);
			for (const receipt of supplied) {
				const example = GPT_IMAGE_2_6_EXAMPLES[variant].find(
					(example) => example.id === receipt.id,
				)!;
				expect(example.prompt).toBe(receipt.example.input.prompt);
				expect(receipt.model).toMatch(new RegExp(`^gpt-image-2-6/${variant}-`));
				expect(example.image.src).toBe(receipt.files[0]!.output.src);
				expect(example.selection.productKey).toBe(`image-gpt-image-2-6-${variant}`);
				const { productKey, ...selection } = example.selection;
				expect(parseImageSelection(productKey, selection)).toMatchObject(selection);
				if (example.animation) {
					expect(example.selection.frameCount).toBe(receipt.files[0]!.source.frames);
				}
			}
			expect(IMAGE_TOOL_PAGES[`gpt-image-2-6-${variant}`].prompts).toEqual(
				GPT_IMAGE_2_6_EXAMPLES[variant],
			);
			for (const example of GPT_IMAGE_2_6_EXAMPLES[variant])
				expect(example.selection.productKey).toBe(`image-gpt-image-2-6-${variant}`);
		},
	);

	it("ships the inspected source-bound images and unchanged Kie animation", async () => {
		for (const receipt of evidence.examples) {
			for (const file of receipt.files) {
				const bytes = readFileSync(new URL(`../../../public${file.output.src}`, import.meta.url));
				expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.output.sha256);
				const metadata = await sharp(bytes).metadata();
				expect([metadata.width, metadata.height]).toEqual([file.output.width, file.output.height]);
				if ("animation" in file && file.animation) {
					const animation = readFileSync(
						new URL(`../../../public${file.animation}`, import.meta.url),
					);
					expect(createHash("sha256").update(animation).digest("hex")).toBe(file.source.sha256);
				}
			}
		}
	});

	it("keeps the real EzImageAI GIF in Sunburst with its exact frame controls", () => {
		expect(GPT_IMAGE_2_6_ORIGAMI_EXAMPLE.prompt).toBe(origami.prompt);
		expect(GPT_IMAGE_2_6_ORIGAMI_EXAMPLE.selection).toMatchObject({
			productKey: origami.productKey,
			frameCount: origami.requested.frameCount,
			frameDurationMs: origami.requested.frameDurationMs,
		});
		expect(GPT_IMAGE_2_6_EXAMPLES.flare).not.toContain(GPT_IMAGE_2_6_ORIGAMI_EXAMPLE);
	});
});
