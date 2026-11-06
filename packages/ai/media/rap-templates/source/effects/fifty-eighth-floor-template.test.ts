import { describe, expect, it } from "vitest";

import {
	FLOOR58_ID,
	FLOOR58_MODES,
	FLOOR58_REVISION,
	floor58Prices,
	floor58RequestSchema,
	type Floor58Mode,
} from "../fifty-eighth-floor";
import { FLOOR58_PRIVATE_CONFIG_KEY } from "../floor58-template";
import { floor58Fixture } from "./__fixtures__/floor58";
import { floor58Body, readFloor58Template } from "./fifty-eighth-floor-template.server";

const input = (preset: Floor58Mode = "duo") => ({
	templateId: FLOOR58_ID,
	preset,
	revision: FLOOR58_REVISION,
	duration: 15 as const,
	aspectRatio: "9:16" as const,
	resolution: "768P" as const,
	imageUrl: "https://media.example.com/a.png",
	...(preset === "solo" ? {} : { secondImageUrl: "https://media.example.com/b.png" }),
	expectedCredits: 10,
	idempotencyKey: crypto.randomUUID(),
});

describe("58th Floor fixed H3 input", () => {
	it("requires the saved backend template and preserves complete R2 URLs", () => {
		expect(() => readFloor58Template({})).toThrow("EFFECT_TEMPLATE_NOT_CONFIGURED");
		const template = {
			...floor58Fixture,
			sceneImageUrl: "https://media.example.com/uploads/effects/scene-v2.png",
		};
		const config = { [FLOOR58_PRIVATE_CONFIG_KEY]: JSON.stringify(template) };
		expect(readFloor58Template(config)).toEqual(template);
		expect(floor58Body(input(), config).input.reference_image_urls[2]).toBe(template.sceneImageUrl);
		expect(() =>
			readFloor58Template({
				[FLOOR58_PRIVATE_CONFIG_KEY]: JSON.stringify({
					...template,
					sceneImageUrl: "http://localhost/x",
				}),
			}),
		).toThrow();
	});
	it.each(FLOOR58_MODES)(
		"keeps %s identity images before fixed scene, poses and audio",
		(preset) => {
			const body = floor58Body(input(preset), {
				[FLOOR58_PRIVATE_CONFIG_KEY]: JSON.stringify(floor58Fixture),
			});
			expect(body.model).toBe("minimax-h3/reference-to-video");
			expect(body.input.reference_image_urls).toEqual([
				"https://media.example.com/a.png",
				...(preset === "solo" ? [] : ["https://media.example.com/b.png"]),
				"https://media.example.com/effects/58th-floor/references/scene-clean.png",
				"https://media.example.com/effects/58th-floor/references/h3-01-duo-pose.png",
				"https://media.example.com/effects/58th-floor/references/h3-02-right-closeup.png",
			]);
			expect(body.input.reference_audio_urls).toEqual([
				"https://media.example.com/effects/58th-floor/reference-audio-15s.wav",
			]);
			expect(body.input.prompt.trim().length).toBeGreaterThan(100);
			expect(body.input.prompt.length).toBeLessThanOrEqual(7000);
			expect(body.input).not.toHaveProperty("reference_video_urls");
		},
	);
	it("rejects changed picture counts, durations and private reference injection", () => {
		expect(
			floor58RequestSchema.safeParse({
				...input("solo"),
				secondImageUrl: "https://media.example.com/b.png",
			}).success,
		).toBe(false);
		expect(floor58RequestSchema.safeParse({ ...input(), secondImageUrl: undefined }).success).toBe(
			false,
		);
		expect(floor58RequestSchema.safeParse({ ...input(), duration: 10 }).success).toBe(false);
		expect(
			floor58RequestSchema.safeParse({
				...input(),
				reference_audio_urls: ["https://attacker.example/audio.wav"],
			}).success,
		).toBe(false);
	});
	it("quotes native output quality and fails closed on invalid configured costs", () => {
		expect(floor58Prices({})).toEqual({ "768P": 10, "2K": 20 });
		expect(floor58Prices({ floor58_768p_credits: "0", floor58_2k_credits: "25" })).toEqual({
			"768P": null,
			"2K": 25,
		});
	});
});
