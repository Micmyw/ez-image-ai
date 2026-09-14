import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MODEL_PAGES } from "./model-pages";

describe("model artwork", () => {
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
