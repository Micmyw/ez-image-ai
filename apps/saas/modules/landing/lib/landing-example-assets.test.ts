import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
] as const;

describe("landing visual example assets", () => {
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
