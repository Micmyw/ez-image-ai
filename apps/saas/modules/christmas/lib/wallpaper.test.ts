import { describe, expect, it } from "vitest";

import {
	buildChristmasPrompt,
	CHRISTMAS_STYLES,
	DEFAULT_WALLPAPER_SETTINGS,
	WALLPAPER_TARGETS,
	wallpaperCrop,
} from "./wallpaper";

describe("Christmas wallpaper composition", () => {
	it("changes composition for desktop rather than stretching the phone instruction", () => {
		const phone = buildChristmasPrompt(DEFAULT_WALLPAPER_SETTINGS);
		const desktop = buildChristmasPrompt({ ...DEFAULT_WALLPAPER_SETTINGS, screen: "desktop" });
		expect(phone).toContain("upper third");
		expect(phone).toContain("top of the head below this clear area");
		expect(phone.indexOf("tall 9:16")).toBeLessThan(phone.indexOf(CHRISTMAS_STYLES[0].scene));
		expect(desktop).toContain("right half");
		expect(desktop).toContain("left for desktop icons");
		expect(desktop).not.toContain("tall 9:16");
	});
	it("preserves identity and clothing by default across all six styles", () => {
		expect(new Set(CHRISTMAS_STYLES.map((style) => style.id)).size).toBe(6);
		for (const { id, scene, photoDirection } of CHRISTMAS_STYLES) {
			const prompt = buildChristmasPrompt({ ...DEFAULT_WALLPAPER_SETTINGS, style: id });
			expect(prompt).toContain(scene);
			expect(prompt).toContain(photoDirection);
			expect(prompt).toContain("Keep any reference subject's original clothing");
			expect(prompt).toContain("do not add or merge people");
			expect(prompt).toContain("Replace the original background completely");
			expect(prompt).toContain("light direction, color temperature, perspective and scale");
			expect(prompt).toContain("No text");
		}
	});
	it("scene mode does not ask to copy a reference person or change their clothing", () => {
		const prompt = buildChristmasPrompt({
			...DEFAULT_WALLPAPER_SETTINGS,
			mode: "scene",
			festiveOutfit: true,
		});
		expect(prompt).toContain("Create the scene without people");
		expect(prompt).not.toContain("Use the uploaded photo");
		expect(prompt).not.toContain("original clothing");
		expect(prompt).not.toContain("add a simple festive knit sweater");
		expect(prompt).not.toContain("golden retriever");
		expect(
			buildChristmasPrompt({ ...DEFAULT_WALLPAPER_SETTINGS, mode: "scene", style: "pet" }),
		).toContain("golden retriever");
	});
	it.each(CHRISTMAS_STYLES.map((style) => style.id))(
		"keeps scene-only %s prompts free of clothing instructions",
		(style) => {
			const prompt = buildChristmasPrompt({
				...DEFAULT_WALLPAPER_SETTINGS,
				style,
				mode: "scene",
				festiveOutfit: true,
			});
			const template = CHRISTMAS_STYLES.find((item) => item.id === style)!;
			expect(prompt).toContain(template.scene);
			expect(prompt).not.toContain(template.photoDirection);
			expect(prompt).not.toContain("original clothing");
			expect(prompt).not.toContain("knit sweater");
			expect(prompt).not.toContain("bandana");
		},
	);
	it("allows an explicit festive outfit in the pet style without a conflicting costume instruction", () => {
		const prompt = buildChristmasPrompt({
			...DEFAULT_WALLPAPER_SETTINGS,
			style: "pet",
			festiveOutfit: true,
		});
		expect(prompt).toContain("small festive bandana");
		expect(prompt).not.toContain("no costume");
		expect(prompt).not.toContain("original clothing");
		expect(prompt).toContain("pet's species");
	});
	it("keeps the entire snow globe together in both screen compositions", () => {
		for (const screen of ["phone", "desktop"] as const) {
			const prompt = buildChristmasPrompt({
				...DEFAULT_WALLPAPER_SETTINGS,
				style: "globe",
				screen,
			});
			expect(prompt).toContain("complete round globe and its base together");
			expect(prompt).toContain("same subject fully inside the globe");
			expect(prompt).toContain("focal arrangement");
		}
	});
});

describe("crop pixels and output resolution", () => {
	it("does not lose a source pixel to floating-point rounding", () => {
		expect(wallpaperCrop(941, 1672, "desktop")).toMatchObject({ width: 941, height: 529 });
	});
	it("does not enlarge a 1K image to advertise a 1080p download", () => {
		const crop = wallpaperCrop(576, 1024, "phone");
		expect(crop.width).toBe(576);
		expect(crop.height).toBe(1024);
	});
	it("fits desktop from a portrait without distortion or transparent gaps", () => {
		const crop = wallpaperCrop(1000, 1800, "desktop");
		expect(crop.sw / crop.sh).toBeCloseTo(16 / 9);
		expect(crop.sy).toBeGreaterThan(0);
		expect(crop.width).toBe(1000);
		expect(crop.height).toBe(562);
	});
	it("keeps extreme pan and zoom positions within the image at every target", () => {
		for (const target of Object.keys(WALLPAPER_TARGETS) as (keyof typeof WALLPAPER_TARGETS)[]) {
			for (const x of [-10, 0, 50, 100, 120])
				for (const y of [0, 100])
					for (const zoom of [0.5, 1, 3, 4]) {
						const crop = wallpaperCrop(3840, 2160, target, x, y, zoom);
						expect(crop.sx).toBeGreaterThanOrEqual(0);
						expect(crop.sy).toBeGreaterThanOrEqual(0);
						expect(crop.sx + crop.sw).toBeLessThanOrEqual(3840.00001);
						expect(crop.sy + crop.sh).toBeLessThanOrEqual(2160.00001);
						expect(crop.width).toBeLessThanOrEqual(WALLPAPER_TARGETS[target].width);
						expect(crop.height).toBeLessThanOrEqual(WALLPAPER_TARGETS[target].height);
					}
		}
	});
	it.each([0, -1, NaN, Infinity])("rejects invalid source dimensions %s", (width) => {
		expect(() => wallpaperCrop(width, 100, "phone")).toThrow();
	});
});
