import { describe, expect, it } from "vitest";

import { composeRapDraft, type RapComposerOptions } from "./rap-composer";
import { type RapPromptRequest } from "./rap-composition";
import { createRapProject, RAP_DEFAULT_DRAFT, validateRapDraft } from "./rap-draft";
import { rapGenerationSchema } from "./rap-generation";
import { RAP_PRESET_LYRICS } from "./rap-lyrics";
import { buildRapPrompt } from "./rap-prompt.server";
import en from "./rap-prompts/en.json";
import zh from "./rap-prompts/zh.json";
import { seedanceBody } from "./seeapi-video";

const stages = {
	"orange-studio": "orange",
	"street-cypher": "street",
	"neon-rap": "neon",
	"funny-rap": "funny",
} as const;
describe.each(["en", "zh"] as const)(
	"server composition preserves the existing prompt (%s)",
	(locale) => {
		const messages = locale === "zh" ? zh : en;
		it.each([5, 8, 10, 12, 15] as const)(
			"matches the original composer at %s seconds across all stages and inputs",
			(duration) => {
				for (const stageId of Object.keys(stages) as Array<keyof typeof stages>) {
					for (const direction of ["", "My friend Sam loves hiking."]) {
						for (const photoCount of [0, 1, 2]) {
							for (const customStage of ["", "A rooftop at sunrise."]) {
								const input: RapPromptRequest = {
									composition: { stageId, locale, customStage },
									direction,
									duration,
									aspectRatio: "9:16",
									photoCount,
								};
								const options: RapComposerOptions = {
									stage: {
										prompt: messages[`rap.gallery.${stages[stageId]}.prompt`],
										defaultLyrics: RAP_PRESET_LYRICS[stageId],
									},
									customStage,
									copy: {
										withPhotos: messages["rap.prompt.with_photos"],
										withoutPhotos: messages["rap.prompt.without_photos"],
										scene: messages["rap.prompt.scene"],
										song: messages["rap.prompt.song"],
										occasion: messages["rap.prompt.occasion"],
										content: messages["rap.prompt.content"],
										defaultSong: messages["rap.prompt.default_song"],
										customerSong: messages["rap.prompt.customer_song"],
										freestyleSong: messages["rap.prompt.freestyle_song"],
										performance: messages["rap.prompt.performance"],
										format: (duration, ratio) =>
											messages["rap.prompt.format"]
												.replace("{duration}", String(duration))
												.replace("{ratio}", ratio),
									},
								};
								const legacy = composeRapDraft(
									{
										...RAP_DEFAULT_DRAFT,
										duration,
										direction,
										photos: Array.from(
											{ length: photoCount },
											() => new File(["photo"], "photo.png", { type: "image/png" }),
										),
									},
									options,
								);
								expect(buildRapPrompt(input)).toBe(legacy.direction);
							}
						}
					}
				}
			},
		);
	},
);

it("sends a brief from the browser, exports only that brief, and composes the provider prompt on the server", () => {
	const draft = {
		...RAP_DEFAULT_DRAFT,
		composition: { stageId: "neon-rap" as const, locale: "en" as const },
	};
	expect(validateRapDraft(draft)).toEqual({});
	const project = createRapProject(draft);
	expect(project.direction).toBe("");
	expect(JSON.stringify(project)).not.toContain("Performance:");
	const { photos: _, ...settings } = draft;
	const input = rapGenerationSchema.parse({
		...settings,
		expectedCredits: 10,
		idempotencyKey: crypto.randomUUID(),
	});
	const prompt = buildRapPrompt({ ...settings, photoCount: 0, duration: 12 });
	expect(seedanceBody(input).input.prompt).toBe(prompt);
	expect(seedanceBody(input).input.prompt).toContain("Small nods, rhythmic upper-body movement");
	expect(rapGenerationSchema.safeParse({ ...input, composition: undefined }).success).toBe(false);
});

it.each(["en", "zh"] as const)(
	"keeps photo identity, auto framing and customer occasion instructions (%s)",
	(locale) => {
		const messages = locale === "zh" ? zh : en;
		const { photos: _photos, ...base } = RAP_DEFAULT_DRAFT;
		const input = rapGenerationSchema.parse({
			...base,
			mode: "image",
			modelId: "seedance-2-5",
			aspectRatio: "adaptive",
			imageUrl: "https://media.example/approved.png",
			direction: "Sam loves hiking.",
			composition: { stageId: "neon-rap", locale, occasion: "Birthday" },
			expectedCredits: 37,
			idempotencyKey: crypto.randomUUID(),
		});
		const body = seedanceBody(input);
		expect(body.endpoint).toBe("reference-to-video");
		expect(body.input).toMatchObject({
			reference_images: ["https://media.example/approved.png"],
		});
		expect(body.input.prompt).toContain(messages["rap.prompt.with_photos"]);
		expect(body.input.prompt).toContain(messages["rap.prompt.adaptive_ratio"]);
		expect(body.input.prompt).toContain("Birthday");
		expect(body.input.prompt).toContain("Sam loves hiking.");
		expect(body.input.prompt).not.toContain(RAP_PRESET_LYRICS["neon-rap"][0]);
	},
);
