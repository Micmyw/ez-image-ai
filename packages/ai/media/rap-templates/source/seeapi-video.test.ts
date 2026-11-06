import { describe, expect, it, vi } from "vitest";

import type { HotelLobbyInput } from "./hotel-lobby";
import { RAP_MODEL_IDS } from "./rap-catalog";
import { RAP_DEFAULT_DRAFT } from "./rap-draft";
import type { RapGenerationInput } from "./rap-generation";
import { hotelLobbyBody, SeeapiVideoClient, seedanceBody } from "./seeapi-video";

describe("Hotel Lobby hosted template transport", () => {
	const request: HotelLobbyInput = {
		templateId: "hotel-lobby-ai",
		imageUrl: "https://media.example.com/left.png",
		secondImageUrl: "https://media.example.com/right.png",
		resolution: "2K",
		aspectRatio: "9:16",
		expectedCredits: 20,
		idempotencyKey: crypto.randomUUID(),
	};
	const task = {
		id: "hotel_task",
		template_id: "hotel-lobby-ai",
		provider: "seeapi",
		status: "processing",
	};
	it("uses the dedicated endpoint, ordered portraits, stable key and unified task lookup", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => Response.json({ generation: task }));
		const client = new SeeapiVideoClient({ apiKey: "fixture", fetch: fetcher });
		const body = hotelLobbyBody(request, "https://app.example.com/api/rap/callback/fixture");
		await client.submit(body, "hotel_stable_key");
		const [url, init] = fetcher.mock.calls[0];
		expect(url).toBe("https://api.seeapi.com/v1/templates/hotel-lobby-ai/generations");
		expect(JSON.parse(init?.body as string)).toEqual({
			provider: "seeapi",
			callback_url: body.callback_url,
			input: {
				reference_images: [request.imageUrl, request.secondImageUrl],
				aspect_ratio: "9:16",
				resolution: "2K",
			},
		});
		expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("hotel_stable_key");
		expect(init?.redirect).toBe("manual");
		await client.query("hotel_task", undefined, "hotel-lobby-ai");
		expect(fetcher.mock.calls[1][0]).toBe("https://api.seeapi.com/v1/generations/hotel_task");
	});
	it.each([
		{ ...task, template_id: "different-template" },
		{ ...task, status: "succeeded", result: { assets: [] } },
		{ ...task, id: "different-task" },
	])("rejects mismatched identities and incomplete successful results", async (generation) => {
		const client = new SeeapiVideoClient({
			apiKey: "fixture",
			fetch: vi.fn().mockResolvedValue(Response.json({ generation })),
		});
		await expect(client.query("hotel_task", undefined, "hotel-lobby-ai")).rejects.toBeInstanceOf(
			Error,
		);
	});
});

const input: RapGenerationInput = {
	...RAP_DEFAULT_DRAFT,
	duration: 12,
	direction: "A rooftop rap performance",
	idempotencyKey: crypto.randomUUID(),
	expectedCredits: 10,
};
const generation = (overrides = {}) => ({
	id: "task_fixture",
	model: "seedance-2-mini",
	endpoint: "text-to-video",
	provider: "seeapi",
	status: "processing",
	...overrides,
});

describe("SEEAPI Seedance generation contract", () => {
	it("sends an HTTPS callback only at the documented top level and keeps it in the idempotent body", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ generation: generation() }));
		const client = new SeeapiVideoClient({
			apiKey: "fixture-key",
			fetch: fetcher,
		});
		const body = seedanceBody(input, "https://app.example.com/api/rap/callback/rap_fixture");
		await client.submit(body, "same_key");
		expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toMatchObject({
			callback_url: body.callback_url,
		});
		expect(body.input).not.toHaveProperty("callback_url");
		expect(seedanceBody(input)).not.toHaveProperty("callback_url");
		for (const callback of [
			"http://app.example.com/callback",
			"https://user:pass@app.example.com/callback",
			"https://app.example.com/callback#fragment",
		]) {
			await expect(client.submit(seedanceBody(input, callback), "same_key")).rejects.toMatchObject({
				code: "RAP_INPUT_INVALID",
			});
		}
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it.each(RAP_MODEL_IDS)(
		"sends composed scenes verbatim with one or two identity references for %s",
		(modelId) => {
			const direction = "A sunrise rooftop performance. Rap about Sam and hiking.";
			for (const secondImageUrl of [undefined, "https://media.example.com/partner.png"]) {
				const body = seedanceBody({
					...input,
					modelId,
					direction,
					promptVersion: 1,
					mode: "image",
					imageUrl: "https://media.example.com/group.png",
					secondImageUrl,
				});
				expect(body.endpoint).toBe("reference-to-video");
				expect(body.input.prompt).toBe(direction);
				expect(body.input).toHaveProperty(
					"reference_images",
					["https://media.example.com/group.png", secondImageUrl].filter(Boolean),
				);
				expect(body.input).not.toHaveProperty("first_frame_image");
			}
		},
	);
	it.each(RAP_MODEL_IDS)(
		"does not append legacy preset styling to a composed text prompt for %s",
		(modelId) => {
			const direction = "An outdoor acoustic rap performance on a rooftop.";
			const body = seedanceBody({
				...input,
				modelId,
				direction,
				promptVersion: 1,
			});
			expect(body.endpoint).toBe("text-to-video");
			expect(body.input.prompt).toBe(direction);
			expect(body.input).not.toHaveProperty("reference_images");
			expect(body.input).not.toHaveProperty("first_frame_image");
		},
	);
	it.each(RAP_MODEL_IDS)(
		"submits both identities with the native reference endpoint for %s and queries its result",
		async (modelId) => {
			const body = seedanceBody({
				...input,
				modelId,
				mode: "image",
				imageUrl: "https://media.example.com/person-one.png",
				secondImageUrl: "https://media.example.com/person-two.png",
			});
			expect(body.endpoint).toBe("reference-to-video");
			expect(body.input).toMatchObject({
				reference_images: [
					"https://media.example.com/person-one.png",
					"https://media.example.com/person-two.png",
				],
			});
			expect(body.input).not.toHaveProperty("first_frame_image");
			expect(body.input).not.toHaveProperty("last_frame_image");
			const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
				Response.json({
					generation: generation({
						model: modelId,
						endpoint: "reference-to-video",
					}),
				}),
			);
			const client = new SeeapiVideoClient({
				apiKey: "fixture-key",
				fetch: fetcher,
			});
			await client.submit(body, "stable_duo_key");
			expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual(body);
			expect(await client.query("task_fixture", "reference-to-video", modelId)).toMatchObject({
				endpoint: "reference-to-video",
				status: "processing",
			});
		},
	);
	it("sends the documented text/image endpoints with stable idempotency and upstream safety enabled", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ generation: generation() }, { status: 202 }));
		const client = new SeeapiVideoClient({
			apiKey: "fixture-key",
			fetch: fetcher,
		});
		const body = seedanceBody(input);
		await client.submit(body, "stable_key");
		const [url, init] = fetcher.mock.calls[0];
		expect(url).toBe("https://api.seeapi.com/v1/generations");
		expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("stable_key");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-key");
		expect(JSON.parse(init?.body as string)).toMatchObject({
			model: "seedance-2-mini",
			endpoint: "text-to-video",
			provider: "seeapi",
			input: {
				duration_seconds: 12,
				resolution: "720p",
				nsfw_checker: true,
				generate_audio: true,
			},
		});
		expect(body.input).not.toHaveProperty("first_frame_image");
		expect(
			seedanceBody({
				...input,
				mode: "image",
				imageUrl: "https://media.example.com/photo.png",
			}),
		).toMatchObject({
			endpoint: "image-to-video",
			input: { first_frame_image: "https://media.example.com/photo.png" },
		});
		expect(JSON.stringify(body)).not.toMatch(/audio_url|audio_file/);
	});
	it.each([
		{ id: "task_other" },
		{ provider: "replicate" },
		{ endpoint: "image-to-video" },
		{ model: "other" },
		{ model: "seedance-2" },
		{ status: "succeeded", result: { assets: [] } },
		{
			status: "succeeded",
			result: { assets: [{ type: "video", url: "http://127.0.0.1/file" }] },
		},
		{
			status: "succeeded",
			result: {
				assets: [{ type: "video", url: "https://user:pass@example.com/file.mp4" }],
			},
		},
	])("rejects mismatched or unsafe results: %j", async (overrides) => {
		const client = new SeeapiVideoClient({
			apiKey: "fixture",
			fetch: vi.fn().mockResolvedValue(Response.json({ generation: generation(overrides) })),
		});
		await expect(
			client.query("task_fixture", "text-to-video", "seedance-2-mini"),
		).rejects.toThrow();
	});
	it("rejects a submission response for another supported model", async () => {
		const client = new SeeapiVideoClient({
			apiKey: "fixture",
			fetch: vi
				.fn()
				.mockResolvedValue(Response.json({ generation: generation({ model: "seedance-2-5" }) })),
		});
		await expect(client.submit(seedanceBody(input), "key")).rejects.toMatchObject({
			code: "RAP_PROVIDER_RESPONSE_INVALID",
			definiteRejection: false,
		});
	});
	it("returns all video assets and distinguishes terminal state from HTTP success", async () => {
		const data = generation({
			status: "succeeded",
			result: {
				assets: [
					{ type: "video", url: "https://media.example.com/1.mp4" },
					{ type: "video", url: "https://media.example.com/2.mp4" },
				],
			},
		});
		const client = new SeeapiVideoClient({
			apiKey: "fixture",
			fetch: vi.fn().mockResolvedValue(Response.json({ generation: data })),
		});
		expect(
			(await client.query("task_fixture", "text-to-video", "seedance-2-mini")).result?.assets,
		).toHaveLength(2);
	});
	it.each([409, 429, 500, 503, 504])(
		"does not label HTTP %s an unambiguous submission rejection",
		async (status) => {
			const client = new SeeapiVideoClient({
				apiKey: "fixture",
				fetch: vi.fn().mockResolvedValue(new Response("", { status })),
			});
			await expect(client.submit(seedanceBody(input), "key")).rejects.toMatchObject({
				definiteRejection: false,
			});
		},
	);
	it("treats a first request validation rejection as definitive", async () => {
		const client = new SeeapiVideoClient({
			apiKey: "fixture",
			fetch: vi.fn().mockResolvedValue(new Response("", { status: 400 })),
		});
		await expect(client.submit(seedanceBody(input), "key")).rejects.toMatchObject({
			definiteRejection: true,
		});
	});
});
