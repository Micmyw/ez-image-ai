import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { MINIMAX_H3_EXAMPLES } from "./minimax-h3-examples";
import { IMAGE_TOOL_PAGES } from "./tool-pages";

const evidence = JSON.parse(
	readFileSync(
		new URL(
			"../../../../../docs/operations/evidence/minimax-h3-page-materials-2026-11-13.json",
			import.meta.url,
		),
		"utf8",
	),
) as {
	examples: Array<{
		example: { input: { prompt: string; image_urls?: string[] } };
		files: Array<{ output: { src: string; sha256: string; width: number; height: number } }>;
	}>;
};

describe("MiniMax H3 supplied examples", () => {
	it("keeps the supplied prompts verbatim and uses only supported single-reference edits", () => {
		expect(MINIMAX_H3_EXAMPLES).toHaveLength(4);
		for (const [index, example] of MINIMAX_H3_EXAMPLES.entries()) {
			const receipt = evidence.examples[index]!;
			expect(example.prompt).toBe(receipt.example.input.prompt);
			expect(receipt.example.input.image_urls?.length ?? 0).toBeLessThanOrEqual(1);
		}
		expect(IMAGE_TOOL_PAGES["minimax-h3-image"].promptSource?.href).toBe(
			"https://kie.ai/minimax-h3-image",
		);
		expect(IMAGE_TOOL_PAGES["minimax-h3-image"].showPassOffer).toBe(false);
	});
	it("ships the inspected WebP display files with matching dimensions and hashes", async () => {
		for (const file of evidence.examples.flatMap((example) => example.files)) {
			const bytes = readFileSync(new URL(`../../../public${file.output.src}`, import.meta.url));
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.output.sha256);
			const image = await sharp(bytes).metadata();
			expect(image.format).toBe("webp");
			expect([image.width, image.height]).toEqual([file.output.width, file.output.height]);
		}
	});
});
