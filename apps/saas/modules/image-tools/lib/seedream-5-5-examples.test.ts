import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { SEEDREAM_5_5_EXAMPLES } from "./seedream-5-5-examples";

const evidence = JSON.parse(
	readFileSync(
		new URL(
			"../../../../../docs/operations/evidence/seedream-5-5-page-materials-2026-11-13.json",
			import.meta.url,
		),
		"utf8",
	),
) as {
	examples: Array<{
		key: string;
		example: { input: { prompt: string; size: string; image_urls?: string[] } };
		files: Array<{
			kind: string;
			output: { src: string; sha256: string; width: number; height: number; hasAlpha: boolean };
		}>;
	}>;
};

describe("Seedream 5.5 supplied examples", () => {
	it("keeps the supplied Media.io demo and poster byte-for-byte intact", () => {
		const demo = JSON.parse(
			readFileSync(
				new URL(
					"../../../../../docs/operations/evidence/media-io-seedream-demo-2026-11-13.json",
					import.meta.url,
				),
				"utf8",
			),
		) as { files: Array<{ src: string; bytes: number; sha256: string }> };
		for (const file of demo.files) {
			const bytes = readFileSync(new URL(`../../../public${file.src}`, import.meta.url));
			expect(bytes.length).toBe(file.bytes);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
		}
	});
	it("preserves supplier prompts, request sizes and single-reference provenance", () => {
		for (const example of SEEDREAM_5_5_EXAMPLES) {
			const receipt = evidence.examples.find((item) => item.key === example.id)!;
			expect(example.prompt).toBe(receipt.example.input.prompt);
			expect(example.resolution).toBe(receipt.example.input.size);
			expect(receipt.example.input.image_urls?.length ?? 0).toBeLessThanOrEqual(1);
		}
	});

	it("ships display images with matching identities, dimensions and real transparency", async () => {
		for (const receipt of evidence.examples) {
			for (const file of receipt.files) {
				const bytes = readFileSync(new URL(`../../../public${file.output.src}`, import.meta.url));
				expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.output.sha256);
				const metadata = await sharp(bytes).metadata();
				expect(metadata.format).toBe("webp");
				expect([metadata.width, metadata.height]).toEqual([file.output.width, file.output.height]);
				if (receipt.key === "transparent-product" && file.kind === "output") {
					expect(metadata.hasAlpha).toBe(true);
					const stats = await sharp(bytes).stats();
					expect(stats.isOpaque).toBe(false);
				}
			}
		}
	});
});
