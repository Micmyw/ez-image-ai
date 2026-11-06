import { describe, expect, it, vi } from "vitest";

import { prepareArchivedSourceTemplateConfig } from "./archive";
import { resolveSourceTemplateRequest } from "./contracts";
import { floor58Fixture } from "./source/effects/__fixtures__/floor58";
import {
	retrieveSourceTemplateRequest,
	submitSourceTemplateRequest,
	validateSourceKieH3Request,
} from "./transport";

const images = ["https://private.example.com/a.png", "https://private.example.com/b.png"];
const seeapiRequest = () =>
	resolveSourceTemplateRequest({
		templateKey: "bulin-47",
		userImageUrls: images.slice(0, 1),
		configs: {},
	});
const kieRequest = () =>
	resolveSourceTemplateRequest({
		templateKey: "58th-floor",
		userImageUrls: images,
		configs: { floor58_template_private_key: JSON.stringify(floor58Fixture) },
	});
const options = { apiKey: "test-key", idempotencyKey: "immutable_attempt_v1" };

describe("source transport contracts", () => {
	it("rejects offline material sentinels before any provider call", async () => {
		const request = resolveSourceTemplateRequest({
			templateKey: "bulin-47",
			userImageUrls: images.slice(0, 1),
			configs: prepareArchivedSourceTemplateConfig("bulin-47"),
		});
		const fetcher = vi.fn<typeof fetch>();
		await expect(
			submitSourceTemplateRequest(request, { ...options, fetch: fetcher }),
		).rejects.toThrow("SOURCE_TEMPLATE_MATERIAL_UNBOUND");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("submits the exact source SeeAPI body to the original endpoint once with its stable identity", async () => {
		const request = seeapiRequest();
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				generation: {
					id: "accepted_1",
					model: request.modelId,
					endpoint: request.endpoint,
					provider: "seeapi",
					status: "processing",
				},
			}),
		);
		expect(await submitSourceTemplateRequest(request, { ...options, fetch: fetcher })).toEqual({
			status: "ACCEPTED",
			providerTaskId: "accepted_1",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, init] = fetcher.mock.calls[0]!;
		expect(url).toBe("https://api.seeapi.com/v1/generations");
		expect(JSON.parse(init?.body as string)).toEqual(request.body);
		expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(options.idempotencyKey);
	});
	it("submits source Hotel through its distinct hosted-template endpoint", async () => {
		const request = resolveSourceTemplateRequest({
			templateKey: "source-hotel-lobby",
			userImageUrls: images,
			configs: {},
		});
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				generation: {
					id: "hotel_1",
					template_id: "hotel-lobby-ai",
					provider: "seeapi",
					status: "processing",
				},
			}),
		);
		expect(
			await submitSourceTemplateRequest(request, { ...options, fetch: fetcher }),
		).toMatchObject({ status: "ACCEPTED" });
		expect(fetcher.mock.calls[0]![0]).toBe(
			"https://api.seeapi.com/v1/templates/hotel-lobby-ai/generations",
		);
	});
	it.each(["9:16", "16:9", "1:1", "4:3", "3:4", "21:9", "adaptive"] as const)(
		"keeps Hotel's provider-owned %s contract complete with no invented fields",
		async (aspectRatio) => {
			for (const resolution of ["768P", "2K"] as const) {
				const request = resolveSourceTemplateRequest({
					templateKey: "source-hotel-lobby",
					options: { aspectRatio, resolution },
					userImageUrls: images,
					configs: {},
				});
				expect(request.executionContract).toBe("provider-owned-template");
				expect(request.prompt).toBeNull();
				expect(request.output.durationSeconds).toBeNull();
				expect(request.body).toEqual({
					provider: "seeapi",
					input: { reference_images: images, aspect_ratio: aspectRatio, resolution },
				});
				const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
					Response.json({
						generation: {
							id: "hotel_owned",
							template_id: "hotel-lobby-ai",
							provider: "seeapi",
							status: "processing",
						},
					}),
				);
				expect(
					await submitSourceTemplateRequest(request, { ...options, fetch: fetcher }),
				).toMatchObject({ status: "ACCEPTED" });
				expect(JSON.parse(fetcher.mock.calls[0]![1]?.body as string)).toEqual(request.body);
			}
		},
	);
	it("rejects added client prompt/model/duration in the hosted Hotel transport before network", async () => {
		const request = resolveSourceTemplateRequest({
			templateKey: "source-hotel-lobby",
			userImageUrls: images,
			configs: {},
		});
		const fetcher = vi.fn<typeof fetch>();
		for (const injected of [
			{ prompt: "invented" },
			{ model: "seedance-2-mini" },
			{ duration: 15 },
			{ duration_seconds: 15 },
			{ generate_audio: false },
		]) {
			await expect(
				submitSourceTemplateRequest(
					{
						...request,
						body: { ...request.body, input: { ...request.body.input, ...injected } } as never,
					},
					{ ...options, fetch: fetcher },
				),
			).rejects.toThrow();
		}
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("submits exact source H3 native audio/reference fields without a second request", async () => {
		const request = kieRequest();
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ code: 200, data: { taskId: "h3_1" } }));
		expect(await submitSourceTemplateRequest(request, { ...options, fetch: fetcher })).toEqual({
			status: "ACCEPTED",
			providerTaskId: "h3_1",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]![0]).toBe("https://api.kie.ai/api/v1/jobs/createTask");
		expect(JSON.parse(fetcher.mock.calls[0]![1]?.body as string)).toEqual(request.body);
		expect(request.body.input).not.toHaveProperty("sound");
	});
	it.each([409, 429, 500, 503])(
		"keeps ambiguous status %s reserved without submission retry",
		async (status) => {
			for (const request of [seeapiRequest(), kieRequest()]) {
				const fetcher = vi
					.fn<typeof fetch>()
					.mockResolvedValue(Response.json({ code: status, data: null }, { status }));
				expect(
					await submitSourceTemplateRequest(request, { ...options, fetch: fetcher }),
				).toMatchObject({ status: "UNCERTAIN" });
				expect(fetcher).toHaveBeenCalledTimes(1);
			}
		},
	);
	it("does not infer rejection from a conflicting Kie task identity", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ code: 422, data: { taskId: "possibly_accepted" } }));
		expect(
			await submitSourceTemplateRequest(kieRequest(), { ...options, fetch: fetcher }),
		).toMatchObject({ status: "UNCERTAIN" });
	});
	it.each([seeapiRequest, kieRequest])(
		"keeps disconnects and oversized success envelopes uncertain",
		async (build) => {
			const fail = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("connection reset"));
			expect(await submitSourceTemplateRequest(build(), { ...options, fetch: fail })).toMatchObject(
				{ status: "UNCERTAIN" },
			);
			expect(fail).toHaveBeenCalledTimes(1);
			const large = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(131073)));
			expect(
				await submitSourceTemplateRequest(build(), { ...options, fetch: large }),
			).toMatchObject({ status: "UNCERTAIN" });
			expect(large).toHaveBeenCalledTimes(1);
		},
	);
	it("propagates caller cancellation to both transports without retry", async () => {
		for (const request of [seeapiRequest(), kieRequest()]) {
			const controller = new AbortController();
			controller.abort();
			const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
				expect(init?.signal?.aborted).toBe(true);
				throw new DOMException("Aborted", "AbortError");
			});
			expect(
				await submitSourceTemplateRequest(request, {
					...options,
					signal: controller.signal,
					fetch: fetcher,
				}),
			).toMatchObject({ status: "UNCERTAIN" });
			expect(fetcher).toHaveBeenCalledTimes(1);
		}
	});
	it("queries authenticated SeeAPI state and retains one private output", async () => {
		const request = seeapiRequest();
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				generation: {
					id: "accepted_1",
					model: request.modelId,
					endpoint: request.endpoint,
					provider: "seeapi",
					status: "succeeded",
					result: { assets: [{ type: "video", url: "https://provider.example.com/output.mp4" }] },
				},
			}),
		);
		expect(
			await retrieveSourceTemplateRequest(request, "accepted_1", { ...options, fetch: fetcher }),
		).toMatchObject({
			status: "SUCCEEDED",
			outputUrl: "https://provider.example.com/output.mp4",
			providerCostMicros: null,
		});
	});
	it("queries source H3 identity/model before accepting its native output", async () => {
		const request = kieRequest();
		const response = {
			code: 200,
			data: {
				taskId: "h3_1",
				model: request.modelId,
				state: "success",
				resultJson: JSON.stringify({ resultUrls: ["https://provider.example.com/output.mp4"] }),
			},
		};
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
		expect(
			await retrieveSourceTemplateRequest(request, "h3_1", { ...options, fetch: fetcher }),
		).toMatchObject({ status: "SUCCEEDED" });
		expect(fetcher.mock.calls[0]![0]).toBe("https://api.kie.ai/api/v1/jobs/recordInfo?taskId=h3_1");
		const wrongModel = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json({ ...response, data: { ...response.data, model: "other-model" } }),
			);
		await expect(
			retrieveSourceTemplateRequest(request, "h3_1", { ...options, fetch: wrongModel }),
		).rejects.toThrow("VIDEO_PROVIDER_INVALID_RESPONSE");
	});
	it("rejects invented H3 modalities and fixed-contract changes before network", () => {
		const request = kieRequest();
		expect(() => validateSourceKieH3Request({ ...request.body, model: "seedance-2" })).toThrow();
		expect(() =>
			validateSourceKieH3Request({
				...request.body,
				input: {
					...request.body.input,
					reference_video_urls: ["https://private.example.com/reference.mp4"],
				},
			}),
		).toThrow();
		expect(() =>
			validateSourceKieH3Request({
				...request.body,
				input: { ...request.body.input, duration: 8 },
			}),
		).toThrow();
	});
});
