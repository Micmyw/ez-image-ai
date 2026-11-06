import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
	SPIN_GENERATED_AUDIO,
	SPIN_NEON_LIGHTING,
	SPIN_SOURCE_AUDIO,
	spinDanceBody,
	spinDancePrompt,
} from "./effects/spin-dance-template.server";
import source from "./effects/templates/spin-me-round-v2.json";
import { RAP_DURATIONS, RAP_MODELS, rapAdaptiveRatio, rapResolutions } from "./rap-catalog";
import { rapGenerationSchema } from "./rap-generation";
import {
	SPIN_DANCE_COUNTS,
	SPIN_DANCE_ID,
	SPIN_DANCE_PRESETS,
	SPIN_DANCE_REVISION,
	spinDanceQuote,
	spinDanceRequestSchema,
	spinDanceSettings,
	type SpinDancePreset,
	type SpinDanceSettings,
} from "./spin-dance";

const input = (preset: SpinDancePreset) => ({
	templateId: SPIN_DANCE_ID,
	preset,
	revision: SPIN_DANCE_REVISION,
	...spinDanceSettings(preset),
	imageUrl: "https://media.example.com/a.jpg",
	...(preset !== "solo" ? { secondImageUrl: "https://media.example.com/b.jpg" } : {}),
	...(preset === "trio" ? { thirdImageUrl: "https://media.example.com/c.jpg" } : {}),
	expectedCredits: spinDanceQuote(preset)!,
	idempotencyKey: crypto.randomUUID(),
});

describe("Spin Me Round source and provider contract", () => {
	it.each(SPIN_DANCE_PRESETS)(
		"accepts the homepage catalog and quotes every supported %s setting",
		(preset) => {
			for (const model of RAP_MODELS)
				for (const resolution of rapResolutions(model.id))
					for (const duration of RAP_DURATIONS) {
						const settings: SpinDanceSettings = {
							modelId: model.id,
							resolution,
							duration,
							aspectRatio: rapAdaptiveRatio(model.id, "image") ? "adaptive" : "16:9",
						};
						const expectedCredits = model.prices[resolution]![RAP_DURATIONS.indexOf(duration)];
						expect(spinDanceQuote(preset, settings)).toBe(expectedCredits);
						const request = spinDanceRequestSchema.parse({
							...input(preset),
							...settings,
							expectedCredits,
						});
						expect(spinDanceBody(request, { app_url: "https://app.example.com" })).toMatchObject({
							model: model.id,
							input: {
								resolution,
								duration_seconds: duration,
								aspect_ratio: settings.aspectRatio,
							},
						});
					}
			expect(
				spinDanceQuote(preset, {
					...spinDanceSettings(preset),
					resolution: "1080p",
				}),
			).toBeNull();
		},
	);
	it.each(SPIN_DANCE_PRESETS)("adapts only timing and framing in the %s choreography", (preset) => {
		const original = spinDancePrompt(preset);
		const adapted = spinDancePrompt(preset, "empty-room", {
			duration: 5,
			aspectRatio: "1:1",
		});
		expect(adapted).toContain("Create a 5-second square 1:1");
		const ranges = [...adapted.matchAll(/(\d+(?:\.\d+)?)–(\d+(?:\.\d+)?)s:/g)];
		expect(ranges.length).toBeGreaterThan(3);
		expect(ranges[0][1]).toBe("0");
		expect(ranges[ranges.length - 1]![2]).toBe("5");
		const normalize = (prompt: string) =>
			prompt
				.replace(/Create a \d+-second (vertical 9:16|square 1:1)/, "OPENING")
				.replace(/\d+(?:\.\d+)?–\d+(?:\.\d+)?s:/g, "PHASE:")
				.replace(/(final|last) (half-second|\d+(?:\.\d+)? seconds)/g, "$1 HOLD");
		expect(normalize(adapted)).toBe(normalize(original));
	});
	it("does not insert scene fields into serialized legacy requests", () => {
		const original = spinDanceRequestSchema.parse(input("solo"));
		expect(original).not.toHaveProperty("sceneId");
		expect(JSON.stringify(original)).not.toContain("sceneId");
		expect(
			spinDanceBody(original, { app_url: "https://app.example.com" }).input.reference_images[0],
		).toMatch(/\/scene-v1.png$/);
	});
	it.each(SPIN_DANCE_PRESETS)("only changes scene lighting for the %s neon variant", (preset) => {
		const original = spinDanceBody(input(preset), {
			app_url: "https://app.example.com",
		});
		const request = { ...input(preset), sceneId: "retro-neon" as const };
		const neon = spinDanceBody(request, {
			app_url: "https://app.example.com",
		});
		expect(neon.input.reference_images).toEqual([
			"https://app.example.com/effects/spin-me-round/retro-neon-v1.png",
			...original.input.reference_images.slice(1),
		]);
		const lighting = source[preset].match(/Use the room from Image 1 with bright, even[^.]+\./)![0];
		expect(neon.input.prompt.replace(SPIN_NEON_LIGHTING, lighting)).toBe(original.input.prompt);
		expect(neon.input.prompt).not.toContain("bright, even");
		expect(neon.input).toMatchObject({
			duration_seconds: original.input.duration_seconds,
			resolution: original.input.resolution,
			aspect_ratio: original.input.aspect_ratio,
			generate_audio: true,
		});
		expect(
			spinDanceBody({ ...request, sceneId: "empty-room" }, { app_url: "https://app.example.com" }),
		).toEqual(original);
	});
	it("preserves all three attached source prompts verbatim", () => {
		const markdown = readFileSync(
			new URL("../original-source/spin-me-round-dance-v2.md", import.meta.url),
			"utf8",
		);
		const originals = [...markdown.matchAll(/```text\r?\n([\s\S]*?)\r?\n```/g)]
			.slice(0, 3)
			.map((match) => match[1].replace(/\r\n/g, "\n"));
		expect(SPIN_DANCE_PRESETS.map((preset) => source[preset])).toEqual(originals);
	});
	it.each(SPIN_DANCE_PRESETS)(
		"keeps %s choreography unchanged and puts the room before the owned portraits",
		(preset) => {
			const request = spinDanceRequestSchema.parse(input(preset));
			const body = spinDanceBody(request, {
				app_url: "https://app.example.com",
			});
			expect(spinDancePrompt(preset).replace(SPIN_GENERATED_AUDIO, SPIN_SOURCE_AUDIO)).toBe(
				source[preset],
			);
			expect(body.input.prompt).toBe(
				source[preset].replace(SPIN_SOURCE_AUDIO, SPIN_GENERATED_AUDIO),
			);
			expect(body).toMatchObject({
				model: "seedance-2-mini",
				endpoint: "reference-to-video",
				input: {
					duration_seconds: preset === "trio" ? 15 : 12,
					resolution: "720p",
					aspect_ratio: "9:16",
					generate_audio: true,
				},
			});
			expect(body.input.reference_images).toEqual([
				"https://app.example.com/effects/spin-me-round/scene-v1.png",
				...["a", "b", "c"]
					.slice(0, SPIN_DANCE_COUNTS[preset])
					.map((person) => `https://media.example.com/${person}.jpg`),
			]);
			expect(body.input).not.toHaveProperty("first_frame_image");
			expect(body.input).not.toHaveProperty("reference_audio");
			expect(rapGenerationSchema.safeParse(request).success).toBe(false);
		},
	);
	it.each([
		{ ...input("trio"), thirdImageUrl: undefined },
		{
			...input("duo"),
			secondImageUrl: undefined,
			thirdImageUrl: "https://media.example.com/c.jpg",
		},
		{ ...input("solo"), secondImageUrl: "https://media.example.com/b.jpg" },
		{ ...input("trio"), thirdImageUrl: "https://media.example.com/a.jpg" },
		{ ...input("solo"), duration: 6 },
		{ ...input("trio"), resolution: "1080p" },
		{ ...input("solo"), imageUrl: "http://media.example.com/a.jpg" },
		{ ...input("solo"), prompt: "override choreography" },
		{ ...input("solo"), modelId: "seedance-2-5", aspectRatio: "9:16" },
		{ ...input("solo"), aspectRatio: "adaptive" },
		{ ...input("solo"), sceneId: "unknown-scene" },
		{ ...input("solo"), sceneId: "https://untrusted.example/scene.png" },
		{ ...input("solo"), sceneUrl: "https://untrusted.example/scene.png" },
	])("rejects mismatched counts, settings and customer prompt overrides", (value) => {
		expect(spinDanceRequestSchema.safeParse(value).success).toBe(false);
	});
});
