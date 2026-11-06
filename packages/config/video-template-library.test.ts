import { describe, expect, it } from "vitest";

import {
	FLYING_CAR_DEFAULT_TEMPLATE_KEY,
	FLYING_CAR_TEMPLATE_KEYS,
	FLYING_CAR_VARIANTS,
	getVideoTemplate,
	sourceTemplateDefaults,
	sourceTemplateOptionSets,
	sourceTemplateRoles,
	VIDEO_TEMPLATE_LIBRARY,
} from "./video-template-library";

describe("public video template catalog", () => {
	it("includes the complete source inventory and preserves existing canonical entries", () => {
		expect(VIDEO_TEMPLATE_LIBRARY).toHaveLength(12);
		expect(getVideoTemplate("source-hotel-lobby")?.canonicalPath).toBe(
			"/video-templates/source-hotel-lobby",
		);
		expect(getVideoTemplate("hotel-lobby")?.canonicalPath).toBe("/video-effects/hotel-lobby-ai");
		expect(getVideoTemplate("raindance")?.canonicalPath).toBe("/blog/raindance-ai-trend");
		expect(getVideoTemplate("rumpelstiltskin")?.canonicalPath).toBe(
			"/video/effects/rumpelstiltskin",
		);
		expect(getVideoTemplate("flying-car")).toMatchObject({
			key: FLYING_CAR_DEFAULT_TEMPLATE_KEY,
			canonicalPath: "/video-templates/flying-car",
			name: "Flying Car",
		});
		for (const style of ["orange-studio", "street-cypher", "neon-rap", "funny-rap"]) {
			const template = getVideoTemplate(`rap-${style}`);
			expect(template?.canonicalPath).toBe(`/video-templates/rap-${style}`);
			expect(template?.sample?.poster).toBe(`https://ezairapvideo.com/rap/styles/${style}-hd.webp`);
		}
	});
	it("shows one Flying Car entry while preserving all original execution variants", () => {
		expect(
			VIDEO_TEMPLATE_LIBRARY.filter((item) => item.key.startsWith("flying-car-")),
		).toHaveLength(1);
		const templates = FLYING_CAR_VARIANTS;
		expect(templates.map((item) => item.key)).toEqual(FLYING_CAR_TEMPLATE_KEYS);
		expect(templates[0]?.key).toBe(FLYING_CAR_DEFAULT_TEMPLATE_KEY);
		for (const key of FLYING_CAR_TEMPLATE_KEYS) {
			const ramp = key.includes("curved-ramp");
			const durationSeconds = ramp ? 15 : 7;
			const defaults = sourceTemplateDefaults(key);
			expect(defaults).toEqual({ resolution: "768P", aspectRatio: "16:9", durationSeconds });
			expect(sourceTemplateRoles(key, defaults)).toEqual(["subject"]);
			expect(sourceTemplateOptionSets(key, defaults)).toEqual({
				presets: [],
				tiers: [],
				durations: [durationSeconds],
				resolutions: ["768P", "2K"],
				ratios: ["16:9"],
			});
			expect(getVideoTemplate(key)).toMatchObject({
				canonicalPath: `/video-templates/${key}`,
				inputLabel: "subject",
				availability: "pending",
				sample: { source: "ezrapvideo", shared: ramp },
			});
		}
		expect(new Set(templates.map((item) => item.sample?.video)).size).toBe(3);
		expect(templates[0]?.sample).toEqual(templates[1]?.sample);
	});
	it("never presents imported templates as generation-ready or leaks execution data", () => {
		for (const item of VIDEO_TEMPLATE_LIBRARY.filter((item) =>
			item.canonicalPath.startsWith("/video-templates/"),
		))
			expect(item.availability).not.toBe("existing");
		expect(JSON.stringify(VIDEO_TEMPLATE_LIBRARY)).not.toMatch(
			/referenceAudio|sceneImage|provider|seedance|prompt|credits|verifiedAt/,
		);
		for (const item of VIDEO_TEMPLATE_LIBRARY)
			if (item.sample) {
				for (const url of [item.sample.poster, item.sample.video]) {
					const parsed = new URL(url);
					expect(["ezairapvideo.com", "media.ezairapvideo.com"]).toContain(parsed.hostname);
					expect(parsed.search).toBe("");
				}
			}
	});
	it("preserves role ordering for trio and person-pet requests", () => {
		expect(sourceTemplateRoles("spin-me-round", { preset: "trio" })).toEqual([
			"performer-1",
			"performer-2",
			"performer-3",
		]);
		expect(sourceTemplateRoles("58th-floor", { preset: "person-pet" })).toEqual([
			"performer-1",
			"pet",
		]);
		expect(sourceTemplateRoles("kung-fu-cat", sourceTemplateDefaults("kung-fu-cat"))).toEqual([
			"pet",
		]);
		expect(sourceTemplateRoles("original-rap", { preset: "text" })).toEqual([]);
	});
	it("keeps source-only legal option combinations and provider-defined duration unset", () => {
		expect(sourceTemplateDefaults("source-hotel-lobby").durationSeconds).toBeUndefined();
		expect(sourceTemplateOptionSets("original-rap", { tier: "standard" }).resolutions).toEqual([
			"480p",
			"720p",
		]);
		expect(
			sourceTemplateOptionSets("original-rap", { tier: "ultra", preset: "solo" }).ratios,
		).toEqual(["adaptive"]);
		expect(
			sourceTemplateOptionSets("original-rap", { tier: "ultra", preset: "text" }).ratios,
		).toEqual(["9:16", "1:1", "16:9"]);
		expect(sourceTemplateDefaults("rap-neon-rap").preset).toBe("solo");
		expect(sourceTemplateOptionSets("green-booth-freestyle", {})).toMatchObject({
			durations: [10],
			resolutions: ["768P"],
			ratios: ["16:9"],
		});
	});
});
