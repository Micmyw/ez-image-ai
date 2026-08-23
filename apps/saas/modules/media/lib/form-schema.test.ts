import { describe, expect, it } from "vitest";

import {
	buildGenerationInput,
	generationFieldSchema,
	generationFormValuesSchema,
} from "./form-schema";

describe("generation form schema", () => {
	it.each(["text", "select", "slider", "aspect-ratio", "count", "image-asset", "video-asset"])(
		"accepts the supported %s field",
		(type) =>
			expect(
				generationFieldSchema.safeParse({ type, key: "prompt", label: "Prompt" }).success,
			).toBe(true),
	);

	it("rejects fields outside the finite public schema", () => {
		expect(
			generationFieldSchema.safeParse({ type: "provider", key: "provider", label: "Provider" })
				.success,
		).toBe(false);
	});

	it("builds only public generation input and enforces visible ranges", () => {
		expect(
			buildGenerationInput({
				kind: "text-to-video",
				prompt: "  Paper birds  ",
				durationSeconds: 8,
			}),
		).toEqual({
			kind: "text-to-video",
			prompt: "Paper birds",
			durationSeconds: 8,
		});
		expect(() =>
			buildGenerationInput({ kind: "text-to-video", prompt: "Paper birds", durationSeconds: 99 }),
		).toThrow();
	});

	it("maps the public aspect-ratio control to server-owned image dimensions", () => {
		expect(
			buildGenerationInput({
				kind: "text-to-image",
				prompt: "Square portrait",
				aspectRatio: "1:1",
			}),
		).toEqual({ kind: "text-to-image", prompt: "Square portrait", width: 1024, height: 1024 });
	});

	it("validates the React Hook Form values before quote creation", () => {
		expect(
			generationFormValuesSchema.parse({
				productKey: "image-fast",
				prompt: "  Studio portrait  ",
				aspectRatio: "1:1",
				durationSeconds: 5,
			}),
		).toMatchObject({ prompt: "Studio portrait" });
		expect(() =>
			generationFormValuesSchema.parse({
				productKey: "video-fast",
				prompt: "",
				aspectRatio: "1:1",
				durationSeconds: 31,
			}),
		).toThrow();
	});
});
