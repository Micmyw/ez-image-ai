import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const appDirectory = import.meta.dirname;

describe("SaaS brand assets", () => {
	it("ships the generated EzPic PNG favicon instead of the template icon", () => {
		const iconPath = path.join(appDirectory, "icon.png");
		const icon = readFileSync(iconPath);

		expect(existsSync(iconPath)).toBe(true);
		expect(existsSync(path.join(appDirectory, "icon.svg"))).toBe(false);
		expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		expect(icon.readUInt32BE(16)).toBe(512);
		expect(icon.readUInt32BE(20)).toBe(512);
		expect(icon.byteLength).toBeLessThan(100_000);
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
