import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const appDirectory = import.meta.dirname;

describe("SaaS brand assets", () => {
	it("ships an EzPic SVG favicon instead of the template icon", () => {
		const iconPath = path.join(appDirectory, "icon.svg");

		expect(existsSync(iconPath)).toBe(true);
		expect(existsSync(path.join(appDirectory, "icon.png"))).toBe(false);
		expect(readFileSync(iconPath, "utf8")).toMatch(/EzPic image editor mark/i);
	});

	it("publishes an EzPic Open Graph image route", async () => {
		const source = readFileSync(path.join(appDirectory, "opengraph-image.tsx"), "utf8");
		const openGraphImage = await import("./opengraph-image");

		expect(source).not.toContain("✦");
		expect(openGraphImage.alt).toMatch(/EzPic.*image editor/i);
		expect(openGraphImage.size).toEqual({ width: 1200, height: 630 });
		expect(openGraphImage.contentType).toBe("image/png");
	});
});
