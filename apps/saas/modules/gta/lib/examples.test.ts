import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { GTA_SCENES, defaultGtaSettings } from "./config";
import { GTA_EXAMPLES, findGtaExample } from "./examples";

describe("commissioned public artwork", () => {
	it("matches portrait, task, shape and side without substituting another composition", () => {
		const loading = defaultGtaSettings("loading-art");
		expect(findGtaExample("loading-art", loading)?.id).toBe("loading-neon-right");
		expect(findGtaExample("loading-art", { ...loading, position: "left" })).toBeUndefined();
		expect(findGtaExample("loading-art", { ...loading, format: "phone" })).toBeUndefined();
		const wallpaper = defaultGtaSettings("wallpaper");
		expect(findGtaExample("wallpaper", wallpaper)?.id).toBe("wallpaper-beach-photo");
		expect(findGtaExample("wallpaper", { ...wallpaper, sourceMode: "scene" })?.id).toBe(
			"beach-sunset-phone",
		);
		expect(
			findGtaExample("wallpaper", { ...wallpaper, sceneId: "neon-boulevard", format: "desktop" }),
		).toBeUndefined();
	});
	it("covers both tasks and the six phone scenes with separate source portraits", () => {
		expect(
			GTA_EXAMPLES.filter(
				(item) => item.intent === "wallpaper" && item.format === "phone" && !item.sourceSrc,
			).map((item) => item.sceneId),
		).toEqual(GTA_SCENES.map((scene) => scene.id));
		expect(
			GTA_EXAMPLES.filter((item) => item.intent === "wallpaper" && item.format === "desktop"),
		).toHaveLength(2);
		expect(
			GTA_EXAMPLES.filter((item) => item.intent === "wallpaper" && item.sourceSrc),
		).toHaveLength(2);
		const loading = GTA_EXAMPLES.filter((item) => item.intent === "loading-art");
		expect(loading).toHaveLength(3);
		expect(new Set(loading.map((item) => item.sourceSrc)).size).toBe(3);
		expect(new Set(loading.map((item) => item.position))).toEqual(new Set(["left", "right"]));
	});
	it.each(GTA_EXAMPLES)("publishes the actual source pixels for $id", async (item) => {
		for (const file of [item.src, item.downloadSrc]) {
			expect(file).toMatch(/^\/images\/gta\/[a-z-]+\.(webp|jpg)$/);
			const bytes = await readFile(path.join(process.cwd(), "public", file));
			const dimensions = await sharp(bytes).metadata();
			expect([dimensions.width, dimensions.height]).toEqual([item.width, item.height]);
		}
		if (item.sourceSrc) {
			const dimensions = await sharp(
				await readFile(path.join(process.cwd(), "public", item.sourceSrc)),
			).metadata();
			expect([dimensions.width, dimensions.height]).toEqual([item.sourceWidth, item.sourceHeight]);
		}
	});
});
