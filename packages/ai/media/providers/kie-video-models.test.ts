import {
	VIDEO_MODEL_CATALOG,
	getVideoModelOptions,
	type VideoMode,
} from "@repo/config/video-models";
import { describe, expect, it, vi } from "vitest";

import officialFixture from "../catalog/fixtures/kie-video-model-contracts-2026-10-08.json";
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
function requestParameters(
	request: ReturnType<typeof buildKieVideoModelRequest>,
): Record<string, unknown> {
	return "input" in request ? request.input : request;
}
describe("Kie multi-model video boundary", () => {
	it("keeps the unresolved official Kling Pro square pixel conflict and existing rejection risk visible", () => {
		expect(officialFixture).toHaveProperty(
			"conflicts",
			expect.arrayContaining([
				expect.objectContaining({
					id: "kling-3-pro-square-output-pixels",
					status: "UNRESOLVED",
					source: "https://docs.kie.ai/market/kling/kling-3-0.md",
					proseEvidence: expect.arrayContaining([
						expect.objectContaining({
							location: "Pro Mode (pro) prose resolution table, 1:1 row",
							line: 95,
							width: 1440,
							height: 1440,
						}),
						expect.objectContaining({
							location: "OpenAPI input.mode.description, pro mode 1:1 mapping",
							line: 498,
							width: 1080,
							height: 1080,
						}),
					]),
					applicationPolicy: expect.objectContaining({
						unchanged: true,
						existingClassification: "DOCUMENTED",
						requiredWidth: 1080,
						requiredHeight: 1080,
						failureCode: "VIDEO_RESOLUTION_MISMATCH",
					}),
				}),
			]),
		);
	});
	it("matches each model and input mode to independent official fixed-second evidence including prose-only bounds", () => {
		expect(officialFixture).toHaveProperty("durationEvidence");
		const evidence = Reflect.get(officialFixture, "durationEvidence") as Array<{
			source: string;
			providerModel: string;
			modes: VideoMode[];
			fixedSeconds: number[];
			integerStep: number | null;
		}>;
		expect(evidence).toHaveLength(16);
		expect(new Set(evidence.map((entry) => entry.source))).toEqual(
			new Set(officialFixture.contracts.map((entry) => entry.source)),
		);
		for (const model of VIDEO_MODEL_CATALOG.filter((entry) => entry.status === "implemented")) {
			for (const mode of model.modes) {
				const input = inputFor(model.productKey, mode);
				const providerModel = buildKieVideoModelRequest(input).model;
				const documented = evidence.find(
					(entry) => entry.providerModel === providerModel && entry.modes.includes(mode),
				);
				expect(documented, `${model.productKey}.${mode}`).toBeDefined();
				const seconds = documented!.fixedSeconds;
				expect(
					[
						...new Set(
							getVideoModelOptions(model.productKey, mode).map((option) => option.duration),
						),
					].sort((a, b) => a - b),
					`${model.productKey}.${mode}`,
				).toEqual(seconds);
				expect(seconds.every((value) => Number.isInteger(value) && value > 0)).toBe(true);
				if (documented!.integerStep !== null)
					expect(
						seconds
							.slice(1)
							.every((value, index) => value - seconds[index]! === documented!.integerStep),
					).toBe(true);
				const minimum = seconds[0]!;
				const maximum = seconds[seconds.length - 1]!;
				const gaps = Array.from(
					{ length: maximum - minimum + 1 },
					(_, index) => minimum + index,
				).filter((value) => !seconds.includes(value));
				for (const duration of [-1, minimum - 1, maximum + 1, minimum + 0.5, ...gaps])
					expect(
						() => buildKieVideoModelRequest({ ...input, duration }),
						`${model.productKey}.${mode}: ${duration}`,
					).toThrow();
			}
		}
	});
	it("retains current source evidence and the deliberate application prompt caps", () => {
		expect(officialFixture.retrievedAt).toBe("2026-10-08");
		const contract = officialFixture.contracts.find((entry) =>
			entry.source.endsWith("/seedance-2-5.md"),
		)!;
		expect((contract.request.properties as any).input.properties.prompt.maxLength).toBe(20480);
		expect(
			VIDEO_MODEL_CATALOG.find((entry) => entry.productKey === "video-seedance-2-5")!
				.maxPromptCodePoints,
		).toBe(10000);
		for (const key of ["video-kling-3", "video-kling-2-6-v1"])
			expect(
				VIDEO_MODEL_CATALOG.find((entry) => entry.productKey === key)!.maxPromptCodePoints,
			).toBe(1000);
	});
	it("validates every advertised tuple against current official parameter enums and bounds, including legacy Veo Fast", () => {
		for (const model of VIDEO_MODEL_CATALOG.filter((entry) => entry.status === "implemented")) {
			for (const mode of model.modes) {
				for (const option of getVideoModelOptions(model.productKey, mode)) {
					const request = buildKieVideoModelRequest({
						...inputFor(model.productKey, mode),
						...option,
					});
					const contract = officialFixture.contracts.find((entry) =>
						entry.request.properties.model.enum?.includes(request.model as never),
					)!;
					expect(contract, request.model).toBeDefined();
					const props = contract.request.properties as Record<string, any>;
					const fields = props.input?.properties ?? props;
					for (const [key, value] of Object.entries(requestParameters(request))) {
						expect(fields[key], `${request.model}.${key}`).toBeDefined();
						if (fields[key]?.enum)
							expect(fields[key].enum, `${request.model}.${key}`).toContain(value);
						if (typeof fields[key]?.minimum === "number")
							expect(Number(value)).toBeGreaterThanOrEqual(fields[key].minimum);
						if (typeof fields[key]?.maximum === "number")
							expect(Number(value)).toBeLessThanOrEqual(fields[key].maximum);
					}
				}
			}
		}
	});
	it("omits a new Kling 3 first-frame aspect override while preserving historical frozen requests", () => {
		const current = buildKieVideoModelRequest(inputFor("video-kling-3", "image-to-video"));
		expect(requestParameters(current)).not.toHaveProperty("aspect_ratio");
		const frozen = buildKieVideoModelRequest({
			...inputFor("video-kling-3", "image-to-video"),
			aspectRatio: "9:16",
		});
		expect(requestParameters(frozen).aspect_ratio).toBe("9:16");
	});
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
		for (const model of VIDEO_MODEL_CATALOG.filter(
			(entry) => entry.status === "implemented" && entry.productKey !== "video-veo-3-1-fast",
		)) {
			for (const mode of model.modes) {
				const request = buildKieVideoModelRequest(inputFor(model.productKey, mode));
				if (!("input" in request)) throw new Error("Expected unified provider request");
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
		["video-veo-3-1-fast", "veo3_fast", 4],
	])("uses the documented model and duration type for %s", (key, model, duration) => {
		const request = buildKieVideoModelRequest(inputFor(key as string));
		const parameters = requestParameters(request);
		expect(request.model).toBe(model);
		expect(parameters.duration).toBe(duration);
		expect(request.callBackUrl).toBe(callbackUrl);
		expect(parameters).not.toHaveProperty("productKey");
	});
	it("builds only the approved single first-frame binding for every supported image mode", () => {
		for (const model of VIDEO_MODEL_CATALOG.filter((entry) =>
			entry.modes.includes("image-to-video"),
		)) {
			const request = buildKieVideoModelRequest(inputFor(model.productKey, "image-to-video"));
			const parameters = requestParameters(request);
			const serialized = JSON.stringify(parameters);
			expect(serialized.split(imageUrl).length - 1).toBe(1);
			expect(serialized).not.toContain("sealed-private-asset");
			expect(parameters).not.toHaveProperty("last_frame_url");
			expect(parameters).not.toHaveProperty("reference_video_urls");
		}
	});
	it("serializes real audio switches and never invents a mute field", () => {
		expect(
			requestParameters(buildKieVideoModelRequest({ ...inputFor("video-kling-3"), sound: true }))
				.sound,
		).toBe(true);
		expect(
			requestParameters(buildKieVideoModelRequest({ ...inputFor("video-seedance-2"), sound: true }))
				.generate_audio,
		).toBe(true);
		for (const key of [
			"video-minimax-h3",
			"video-gemini-omni-flash",
			"video-kling-3-turbo",
			"video-veo-3-1",
			"video-veo-3-1-fast",
		]) {
			const parameters = requestParameters(buildKieVideoModelRequest(inputFor(key)));
			expect(parameters).not.toHaveProperty("sound");
			expect(parameters).not.toHaveProperty("generate_audio");
		}
	});
	it("disables prompt transformation and leaves all reference/edit/fallback features out", () => {
		for (const model of VIDEO_MODEL_CATALOG.filter((entry) => entry.status === "implemented")) {
			const request = buildKieVideoModelRequest(inputFor(model.productKey, model.modes[0]));
			const parameters = requestParameters(request);
			expect(parameters).not.toHaveProperty("enable_fallback");
			expect(parameters).not.toHaveProperty("enableFallback");
			expect(parameters).not.toHaveProperty("reference_audio_urls");
			if (model.family === "Seedance") expect(parameters.nsfw_checker).toBe(true);
		}
		expect(
			requestParameters(buildKieVideoModelRequest(inputFor("video-veo-3-1"))).enable_translation,
		).toBe(false);
		expect(
			requestParameters(buildKieVideoModelRequest(inputFor("video-veo-3-1-fast")))
				.enableTranslation,
		).toBe(false);
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
	it("routes Veo Fast creation and retrieval through its documented old API only", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(Response.json({ code: 200, data: { taskId: "veo-task" } }))
			.mockResolvedValueOnce(
				Response.json({ code: 200, data: { taskId: "veo-task", successFlag: 0 } }),
			);
		const adapter = new KieVideoModelsAdapter({ apiKey: "fixture", fetch });
		expect(await adapter.submit(inputFor("video-veo-3-1-fast"))).toEqual({
			status: "ACCEPTED",
			providerTaskId: "veo-task",
		});
		expect(await adapter.retrieve("veo-task", "video-veo-3-1-fast")).toEqual({ status: "PENDING" });
		expect(fetch.mock.calls.map(([url]) => url)).toEqual([
			"https://api.kie.ai/api/v1/veo/generate",
			"https://api.kie.ai/api/v1/veo/record-info?taskId=veo-task",
		]);
		const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
		expect(body).toMatchObject({ model: "veo3_fast", duration: 4, resolution: "720p" });
		expect(body).not.toHaveProperty("input");
	});
});
