import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { MINIMAX_H3_EXAMPLES, MINIMAX_H3_FEATURED_EXAMPLE } from "./minimax-h3-examples";
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

describe("MiniMax H3 showcase", () => {
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
	it("displays the four successful 1K product generations with matching receipts", async () => {
		const live = JSON.parse(
			readFileSync(
				new URL(
					"../../../../../docs/operations/evidence/minimax-h3-live-generation-2026-11-13.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		expect(live.totalCreditsCharged).toBe(25);
		expect(live.featured).toMatchObject({
			...MINIMAX_H3_FEATURED_EXAMPLE,
			kind: "text-to-image",
			referenceImages: 0,
			submissionCount: 1,
			providerAttempts: 1,
			creditsCharged: 5,
			moderation: "APPROVED",
		});
		const featuredBytes = readFileSync(
			new URL(`../../../public${MINIMAX_H3_FEATURED_EXAMPLE.image.src}`, import.meta.url),
		);
		expect(createHash("sha256").update(featuredBytes).digest("hex")).toBe(
			MINIMAX_H3_FEATURED_EXAMPLE.image.sha256,
		);
		expect(live.examples).toHaveLength(4);
		for (const [index, example] of MINIMAX_H3_EXAMPLES.entries()) {
			const receipt = live.examples[index];
			expect(receipt).toMatchObject({
				prompt: example.prompt,
				resolution: "1K",
				creditsCharged: 5,
				creditsReturned: 0,
				providerAttempts: 1,
				moderation: "APPROVED",
				display: example.image,
			});
			expect(example.resolution).toBe("1K");
			const bytes = readFileSync(new URL(`../../../public${example.image.src}`, import.meta.url));
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(example.image.sha256);
			const metadata = await sharp(bytes).metadata();
			expect([metadata.width, metadata.height]).toEqual([
				example.image.width,
				example.image.height,
			]);
		}
	});
});
