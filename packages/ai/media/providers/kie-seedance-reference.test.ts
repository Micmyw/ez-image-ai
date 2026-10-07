import { describe, expect, it, vi } from "vitest";

import {
	buildKieSeedanceReferenceRequest,
	KieSeedanceReferenceAdapter,
	type KieSeedanceReferenceInput,
	kieSeedanceReferenceInputSchema,
} from "./kie-seedance-reference";

const validInput: KieSeedanceReferenceInput = {
	productKey: "video-seedance-2",
	prompt: "Use the identity in image 1 and the motion in video 1.",
	duration: 5,
	resolution: "720p",
	aspectRatio: "9:16",
	sound: false,
	referenceImageUrls: ["https://assets.example.com/identity.png"],
	referenceVideoUrls: ["https://assets.example.com/motion.mp4"],
	callbackUrl: "https://app.example.com/api/provider-callback?token=opaque",
};

describe("Seedance reference input boundary", () => {
	it("maps bounded reference mode to a fixed, silent Seedance 2 request", () => {
		expect(buildKieSeedanceReferenceRequest(validInput)).toEqual({
			model: "bytedance/seedance-2",
			callBackUrl: validInput.callbackUrl,
			input: {
				prompt: validInput.prompt,
				duration: 5,
				resolution: "720p",
				aspect_ratio: "9:16",
				reference_image_urls: validInput.referenceImageUrls,
				reference_video_urls: validInput.referenceVideoUrls,
				generate_audio: false,
				nsfw_checker: true,
				web_search: false,
				return_last_frame: false,
			},
		});
	});

	it.each([
		"first_frame_url",
		"last_frame_url",
		"firstFrameUrl",
		"lastFrameUrl",
		"imageUrl",
		"reference_audio_urls",
		"generate_audio",
		"nsfw_checker",
		"parameters",
	])("rejects the unsupported or mutually exclusive field %s", (field) => {
		expect(() =>
			buildKieSeedanceReferenceRequest({ ...validInput, [field]: "https://assets.example.com/x" }),
		).toThrow();
	});

	it.each([
		["productKey", "video-seedance-2-fast"],
		["duration", 10],
		["resolution", "1080p"],
		["aspectRatio", "16:9"],
		["sound", true],
		["prompt", "   "],
		["prompt", "x".repeat(10001)],
	])("rejects an unsupported %s value", (field, value) => {
		expect(
			kieSeedanceReferenceInputSchema.safeParse({ ...validInput, [field]: value }).success,
		).toBe(false);
	});

	it.each([
		["referenceImageUrls", 0],
		["referenceImageUrls", 10],
		["referenceVideoUrls", 0],
		["referenceVideoUrls", 4],
	])("rejects %s with %s references", (field, count) => {
		expect(
			kieSeedanceReferenceInputSchema.safeParse({
				...validInput,
				[field]: Array.from({ length: count as number }, () => "https://assets.example.com/ref"),
			}).success,
		).toBe(false);
	});

	it("accepts the documented maximum reference counts", () => {
		expect(
			kieSeedanceReferenceInputSchema.safeParse({
				...validInput,
				referenceImageUrls: Array.from({ length: 9 }, () => "https://assets.example.com/image"),
				referenceVideoUrls: Array.from({ length: 3 }, () => "https://assets.example.com/video"),
			}).success,
		).toBe(true);
	});

	it.each([
		"http://assets.example.com/ref",
		"https://user@assets.example.com/ref",
		"https://user:secret@assets.example.com/ref",
		"https://assets.example.com/ref#fragment",
		"not-a-url",
	])("rejects unsafe URLs in every reference and callback: %s", (url) => {
		for (const field of ["referenceImageUrls", "referenceVideoUrls", "callbackUrl"]) {
			expect(
				kieSeedanceReferenceInputSchema.safeParse({
					...validInput,
					[field]: field === "callbackUrl" ? url : [url],
				}).success,
			).toBe(false);
		}
	});

	it("requires the callback and permits signed HTTPS asset queries", () => {
		const { callbackUrl: _callbackUrl, ...withoutCallback } = validInput;
		expect(kieSeedanceReferenceInputSchema.safeParse(withoutCallback).success).toBe(false);
		expect(
			kieSeedanceReferenceInputSchema.safeParse({
				...validInput,
				referenceImageUrls: ["https://assets.example.com/image?signature=opaque"],
			}).success,
		).toBe(true);
	});
});

describe("Seedance reference submission", () => {
	it("accepts a valid task and sends exactly one paid POST with no idempotency claim", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ code: 200, data: { taskId: "seedance_ref_123" } }),
		);
		const adapter = new KieSeedanceReferenceAdapter({ apiKey: "test-key", fetch: fetchMock });
		await expect(adapter.submit(validInput)).resolves.toEqual({
			status: "ACCEPTED",
			providerTaskId: "seedance_ref_123",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, request] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://api.kie.ai/api/v1/jobs/createTask");
		expect(request?.method).toBe("POST");
		expect(request?.redirect).toBe("manual");
		expect(new Headers(request?.headers).get("Idempotency-Key")).toBeNull();
		expect(JSON.parse(request?.body as string)).toEqual(
			buildKieSeedanceReferenceRequest(validInput),
		);
	});

	it("validates the complete input before network submission", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>();
		const adapter = new KieSeedanceReferenceAdapter({ apiKey: "test-key", fetch: fetchMock });
		await expect(
			adapter.submit({
				...validInput,
				first_frame_url: validInput.referenceImageUrls[0],
			} as KieSeedanceReferenceInput),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a missing provider key without a request", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>();
		const adapter = new KieSeedanceReferenceAdapter({ apiKey: "  ", fetch: fetchMock });
		await expect(adapter.submit(validInput)).resolves.toEqual({
			status: "DEFINITELY_REJECTED",
			reasonCode: "VIDEO_PROVIDER_CONFIGURATION_ERROR",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([400, 401, 402, 403, 404, 422])("settles a documented rejection %s", async (code) => {
		for (const status of [200, code]) {
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
				Response.json({ code }, { status }),
			);
			const adapter = new KieSeedanceReferenceAdapter({ apiKey: "test-key", fetch: fetchMock });
			await expect(adapter.submit(validInput)).resolves.toEqual({
				status: "DEFINITELY_REJECTED",
				reasonCode: `VIDEO_PROVIDER_REJECTED_${code}`,
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		}
	});

	it.each([302, 408, 409, 429, 500, 503])(
		"keeps status %s uncertain and does not retry",
		async (status) => {
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
				Response.json({ code: status }, { status }),
			);
			const adapter = new KieSeedanceReferenceAdapter({ apiKey: "test-key", fetch: fetchMock });
			await expect(adapter.submit(validInput)).resolves.toEqual({
				status: "UNCERTAIN",
				reasonCode: "VIDEO_PROVIDER_SUBMISSION_UNCERTAIN",
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		{ code: 200, data: {} },
		{ code: 200, data: { taskId: "invalid/task" } },
		{ code: 200, data: { taskId: "x".repeat(161) } },
		{ message: "unrecognized success" },
	])("keeps malformed success uncertain without a second POST", async (response) => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => Response.json(response));
		const adapter = new KieSeedanceReferenceAdapter({ apiKey: "test-key", fetch: fetchMock });
		await expect(adapter.submit(validInput)).resolves.toMatchObject({ status: "UNCERTAIN" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps a lost response uncertain without retrying", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => {
			throw new TypeError("connection lost after submission");
		});
		const adapter = new KieSeedanceReferenceAdapter({ apiKey: "test-key", fetch: fetchMock });
		await expect(adapter.submit(validInput)).resolves.toMatchObject({ status: "UNCERTAIN" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps invalid JSON uncertain without retrying", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => new Response("invalid json"));
		const adapter = new KieSeedanceReferenceAdapter({ apiKey: "test-key", fetch: fetchMock });
		await expect(adapter.submit(validInput)).resolves.toMatchObject({ status: "UNCERTAIN" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("Seedance reference task retrieval", () => {
	it("uses shared authoritative recordInfo validation", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({
				code: 200,
				data: {
					taskId: "seedance_ref_123",
					state: "success",
					resultJson: JSON.stringify({ resultUrls: ["https://assets.example.com/result.mp4"] }),
					creditsConsumed: 12,
				},
			}),
		);
		const adapter = new KieSeedanceReferenceAdapter({ apiKey: "test-key", fetch: fetchMock });
		await expect(adapter.retrieve("seedance_ref_123")).resolves.toMatchObject({
			status: "SUCCEEDED",
			outputUrl: "https://assets.example.com/result.mp4",
			providerCostMicros: null,
			providerCreditsConsumed: 12,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://api.kie.ai/api/v1/jobs/recordInfo?taskId=seedance_ref_123",
		);
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
	});

	it("rejects a response for a different task", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ code: 200, data: { taskId: "other_task", state: "generating" } }),
		);
		const adapter = new KieSeedanceReferenceAdapter({ apiKey: "test-key", fetch: fetchMock });
		await expect(adapter.retrieve("seedance_ref_123")).rejects.toThrow(
			"VIDEO_PROVIDER_INVALID_RESPONSE",
		);
	});

	it("rejects an invalid task ID before retrieval", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>();
		const adapter = new KieSeedanceReferenceAdapter({ apiKey: "test-key", fetch: fetchMock });
		await expect(adapter.retrieve("../other-task")).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
