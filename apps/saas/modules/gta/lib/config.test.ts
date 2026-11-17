import { describe, expect, it } from "vitest";

import {
	buildGtaPrompt,
	gtaPromptDetails,
	GTA_DETAILS_LIMIT,
	defaultGtaSettings,
	gtaAspectRatio,
	gtaHash,
	GTA_SCENES,
	gtaSettingsFromPrompt,
	parseGtaHash,
	type GtaIntent,
	type GtaSettings,
} from "./config";

describe("coastal artwork presets", () => {
	it("keeps additional preferences separate while changing the fixed scene and layout", () => {
		const initial = defaultGtaSettings("loading-art");
		const details = "Warm light, a blue jacket.\nKeep my glasses.";
		const prompt = buildGtaPrompt("loading-art", initial, details);
		expect(prompt).toContain(buildGtaPrompt("loading-art", initial));
		expect(gtaPromptDetails(prompt, "loading-art", initial)).toBe(details);
		const next = { ...initial, sceneId: "marina" as const, position: "left" as const };
		const changed = buildGtaPrompt(
			"loading-art",
			next,
			gtaPromptDetails(prompt, "loading-art", initial)!,
		);
		expect(changed).toContain("Scene marina.");
		expect(changed).toContain("Portrait left.");
		expect(gtaPromptDetails(changed, "loading-art", next)).toBe(details);
		expect(gtaPromptDetails("An existing custom edit", "loading-art", initial)).toBeNull();
		expect(
			gtaPromptDetails(
				buildGtaPrompt("loading-art", initial, "x".repeat(2000)),
				"loading-art",
				initial,
			),
		).toHaveLength(GTA_DETAILS_LIMIT);
	});
	it("keeps task-specific defaults", () => {
		expect(defaultGtaSettings("wallpaper")).toEqual({
			sceneId: "beach-sunset",
			sourceMode: "photo",
			format: "phone",
			position: "right",
		});
		expect(defaultGtaSettings("loading-art")).toEqual({
			sceneId: "neon-boulevard",
			sourceMode: "photo",
			format: "desktop",
			position: "right",
		});
	});
	it.each(GTA_SCENES)("compiles explicit supported layouts for $id", (scene) => {
		for (const intent of ["wallpaper", "loading-art"] as const) {
			for (const format of ["phone", "desktop"] as const) {
				for (const position of ["left", "right"] as const) {
					const settings: GtaSettings = {
						sceneId: scene.id,
						sourceMode: "photo",
						format,
						position,
					};
					const prompt = buildGtaPrompt(intent, settings);
					expect(prompt).toContain(scene.prompt);
					expect(prompt).toContain(gtaAspectRatio(format));
					expect(prompt).toContain("exactly one main person");
					expect(prompt).not.toMatch(/selected side|selected aspect ratio|\{\{|\[SCENE\]/i);
					expect(gtaSettingsFromPrompt(`${prompt}\nUser's own extra detail`)).toEqual({
						intent,
						settings,
					});
				}
			}
		}
		const sceneSettings: GtaSettings = {
			...defaultGtaSettings("wallpaper"),
			sceneId: scene.id,
			sourceMode: "scene",
		};
		expect(buildGtaPrompt("wallpaper", sceneSettings)).toContain("without people");
		expect(buildGtaPrompt("wallpaper", sceneSettings)).not.toContain("Use the uploaded photo");
	});
	it("rejects unknown and incompatible generation settings", () => {
		expect(() =>
			buildGtaPrompt("loading-art", { ...defaultGtaSettings("loading-art"), sourceMode: "scene" }),
		).toThrow();
		expect(() =>
			buildGtaPrompt("wallpaper", {
				...defaultGtaSettings("wallpaper"),
				sceneId: "private-url" as GtaSettings["sceneId"],
			}),
		).toThrow();
		expect(
			gtaSettingsFromPrompt(
				"Coastal artwork preset gta-coastal-v1. Task loading-art. Scene marina. Input scene. Format phone. Portrait right.",
			),
		).toBeNull();
		expect(gtaSettingsFromPrompt("An unrelated existing job")).toBeNull();
	});
	it.each(["wallpaper", "loading-art"] as GtaIntent[])(
		"whitelists public fragment values for %s",
		(intent) => {
			const parsed = parseGtaHash(
				intent,
				"#scene=marina&format=phone&position=left&mode=scene&asset=private&job=private&prompt=private",
			);
			expect(parsed).toEqual({
				sceneId: "marina",
				format: "phone",
				position: "left",
				sourceMode: intent === "wallpaper" ? "scene" : "photo",
			});
			expect(gtaHash(parsed)).not.toMatch(/asset|job|prompt|private/);
			expect(
				parseGtaHash(intent, "#scene=unknown&format=5k&position=javascript&mode=unknown"),
			).toEqual(defaultGtaSettings(intent));
			expect(parseGtaHash(intent, `#scene=marina&extra=${"x".repeat(256)}`)).toEqual(
				defaultGtaSettings(intent),
			);
		},
	);
});
