import { VIDEO_MODEL_CATALOG, type VideoMode } from "@repo/config/video-models";
import { describe, expect, it, vi } from "vitest";

import officialFixture from "../catalog/fixtures/kie-video-model-contracts-2026-10-04.json";
import {
	buildKieVideoModelRequest,
	KieVideoModelsAdapter,
	type KieVideoModelInput,
} from "./kie-video-models";

const callbackUrl = "https://example.test/api/webhooks/video/kie/token";
const imageUrl = "https://media.example.test/immutable-input.png";
function inputFor(productKey: string, mode: VideoMode = "text-to-video"): KieVideoModelInput {
	const model = VIDEO_MODEL_CATALOG.find((entry) => entry.productKey === productKey)!;
	return {
		productKey,
		mode,
		...model.defaults[mode]!,
		prompt: "A quiet landscape",
		callbackUrl,
		...(mode === "image-to-video" ? { inputAssetId: "sealed-private-asset", imageUrl } : {}),
	};
}
describe("Kie multi-model video boundary", () => {
	it("matches saved official request properties and enums for every implemented mode", () => {
		const contracts = officialFixture.contracts as unknown as Array<{
			request: {
				properties: {
					model: { enum?: string[]; default?: string };
					input: {
						properties: Record<string, { enum?: unknown[] }>;
						required?: string[];
					};
				};
			};
		}>;
		for (const model of VIDEO_MODEL_CATALOG.filter((entry) => entry.status === "implemented")) {
			for (const mode of model.modes) {
				const request = buildKieVideoModelRequest(inputFor(model.productKey, mode));
				const contract = contracts.find(
					(entry) =>
						entry.request.properties.model.enum?.includes(request.model) ||
						entry.request.properties.model.default === request.model,
				)?.request.properties.input;
				expect(contract, request.model).toBeDefined();
				for (const [key, value] of Object.entries(request.input)) {
					expect(contract!.properties[key], `${request.model}.${key}`).toBeDefined();
					if (contract!.properties[key]?.enum)
						expect(contract!.properties[key]!.enum).toContain(value);
				}
				for (const key of contract!.required ?? []) {
					// Kling's prose and single-shot example explicitly make these fields conditional;
					// its generated required[] does not express those conditions.
					if (
						request.model === "kling-3.0/video" &&
						key === "multi_prompt" &&
						request.input.multi_shots === false
					)
						continue;
					if (
						request.model === "kling-3.0/video" &&
						key === "aspect_ratio" &&
						request.input.image_urls
					)
						continue;
					expect(request.input).toHaveProperty(key);
				}
			}
		}
	});
	it.each([
		["video-kling-2-6-v1", "kling-2.6/text-to-video", "5"],
		["video-kling-3", "kling-3.0/video", "5"],
		["video-kling-3-turbo", "kling/v3-turbo-text-to-video", "5"],
		["video-minimax-h3", "minimax-h3/text-to-video", 5],
		["video-seedance-1-5-pro", "bytedance/seedance-1.5-pro", 5],
		["video-seedance-2", "bytedance/seedance-2", 5],
		["video-seedance-2-5", "bytedance/seedance-2-5", 5],
		["video-seedance-2-mini", "bytedance/seedance-2-mini", 5],
		["video-seedance-2-fast", "bytedance/seedance-2-fast", 5],
		["video-gemini-omni-flash", "google/gemini-omni-flash-1-1", "4"],
		["video-veo-3-1", "veo-3-1", 4],
	])("uses the documented model and duration type for %s", (key, model, duration) => {
		const request = buildKieVideoModelRequest(inputFor(key as string));
		expect(request.model).toBe(model);
		expect(request.input.duration).toBe(duration);
		expect(request.callBackUrl).toBe(callbackUrl);
		expect(request.input).not.toHaveProperty("productKey");
	});
	it("builds only the approved single first-frame binding for every supported image mode", () => {
		for (const model of VIDEO_MODEL_CATALOG.filter((entry) =>
			entry.modes.includes("image-to-video"),
		)) {
			const request = buildKieVideoModelRequest(inputFor(model.productKey, "image-to-video"));
			const serialized = JSON.stringify(request.input);
			expect(serialized.split(imageUrl).length - 1).toBe(1);
			expect(serialized).not.toContain("sealed-private-asset");
			expect(request.input).not.toHaveProperty("last_frame_url");
			expect(request.input).not.toHaveProperty("reference_video_urls");
		}
	});
	it("serializes real audio switches and never invents a mute field", () => {
		expect(
			buildKieVideoModelRequest({ ...inputFor("video-kling-3"), sound: true }).input.sound,
		).toBe(true);
		expect(
			buildKieVideoModelRequest({ ...inputFor("video-seedance-2"), sound: true }).input
				.generate_audio,
		).toBe(true);
		for (const key of [
			"video-minimax-h3",
			"video-gemini-omni-flash",
			"video-kling-3-turbo",
			"video-veo-3-1",
		]) {
			const request = buildKieVideoModelRequest(inputFor(key));
			expect(request.input).not.toHaveProperty("sound");
			expect(request.input).not.toHaveProperty("generate_audio");
		}
	});
	it("disables prompt transformation and leaves all reference/edit/fallback features out", () => {
		for (const model of VIDEO_MODEL_CATALOG.filter((entry) => entry.status === "implemented")) {
			const request = buildKieVideoModelRequest(inputFor(model.productKey, model.modes[0]));
			expect(request.input).not.toHaveProperty("enable_fallback");
			expect(request.input).not.toHaveProperty("reference_audio_urls");
			if (model.family === "Seedance") expect(request.input.nsfw_checker).toBe(true);
		}
		expect(buildKieVideoModelRequest(inputFor("video-veo-3-1")).input.enable_translation).toBe(
			false,
		);
	});
	it.each([408, 429, 500, 503])("never retries or fails over ambiguous HTTP %s", async (status) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status }));
		expect(
			(
				await new KieVideoModelsAdapter({ apiKey: "fixture", fetch }).submit(
					inputFor("video-seedance-2"),
				)
			).status,
		).toBe("UNCERTAIN");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("blocks unsupported parameter combinations before any request", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		await expect(
			new KieVideoModelsAdapter({ apiKey: "fixture", fetch }).submit({
				...inputFor("video-minimax-h3"),
				sound: false,
			}),
		).rejects.toThrow();
		await expect(
			new KieVideoModelsAdapter({ apiKey: "fixture", fetch }).submit({
				...inputFor("video-seedance-2"),
				imageUrl,
			}),
		).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});
	it("retrieves authoritative status using the shared recordInfo contract", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({
				code: 200,
				data: {
					taskId: "task_123",
					state: "success",
					resultJson: JSON.stringify({ resultUrls: ["https://cdn.example.test/video.mp4"] }),
					creditsConsumed: 80,
				},
			}),
		);
		const result = await new KieVideoModelsAdapter({ apiKey: "fixture", fetch }).retrieve(
			"task_123",
			"video-minimax-h3",
		);
		expect(result.status).toBe("SUCCEEDED");
		expect(fetch.mock.calls[0]![0]).toBe(
			"https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task_123",
		);
	});
});
