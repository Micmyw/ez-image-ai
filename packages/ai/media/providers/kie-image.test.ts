import { describe, expect, it } from "vitest";

import kieFixtures from "./fixtures/kie.json";
import { KieProviderAdapter } from "./kie";

interface CapturedRequest {
	url: string;
	init?: RequestInit;
}

function capturingFetch(body: unknown, captured: CapturedRequest[]): typeof fetch {
	return (async (url, init) => {
		captured.push({
			url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
			init,
		});
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

function parseCapturedBody(captured: CapturedRequest[]): unknown {
	const body = captured[0]?.init?.body;
	if (typeof body !== "string") throw new Error("Expected a string request body");
	return JSON.parse(body) as unknown;
}

const sourceAsset = {
	assetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
	transferUrl: "https://transfer.test/source.png",
};

describe("Kie image jobs", () => {
	it.each([
		[
			"Nano Banana 2 Lite",
			"nano-banana-2-lite-1k",
			"nano-banana-2-lite",
			"16:9",
			{
				model: "nano-banana-2-lite",
				input: {
					image_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "16:9",
				},
			},
		],
		[
			"Nano Banana",
			"nano-banana-default",
			"google/nano-banana-edit",
			"1:1",
			{
				model: "google/nano-banana-edit",
				input: {
					image_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "1:1",
					output_format: "png",
					nsfw_checker: true,
				},
			},
		],
		[
			"Nano Banana 2 1K",
			"nano-banana-2-1k",
			"nano-banana-2",
			"16:9",
			{
				model: "nano-banana-2",
				input: {
					image_input: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "16:9",
					resolution: "1K",
					output_format: "jpg",
				},
			},
		],
		[
			"Nano Banana 2 2K",
			"nano-banana-2-2k",
			"nano-banana-2",
			"16:9",
			{
				model: "nano-banana-2",
				input: {
					image_input: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "16:9",
					resolution: "2K",
					output_format: "jpg",
				},
			},
		],
		[
			"Nano Banana 2 4K",
			"nano-banana-2-4k",
			"nano-banana-2",
			"16:9",
			{
				model: "nano-banana-2",
				input: {
					image_input: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "16:9",
					resolution: "4K",
					output_format: "jpg",
				},
			},
		],
		[
			"Nano Banana Pro 1K",
			"nano-banana-pro-1k",
			"nano-banana-pro",
			"16:9",
			{
				model: "nano-banana-pro",
				input: {
					image_input: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "16:9",
					resolution: "1K",
					output_format: "png",
				},
			},
		],
		[
			"Nano Banana Pro 2K",
			"nano-banana-pro-2k",
			"nano-banana-pro",
			"16:9",
			{
				model: "nano-banana-pro",
				input: {
					image_input: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "16:9",
					resolution: "2K",
					output_format: "png",
				},
			},
		],
		[
			"Nano Banana Pro 4K",
			"nano-banana-pro-4k",
			"nano-banana-pro",
			"16:9",
			{
				model: "nano-banana-pro",
				input: {
					image_input: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "16:9",
					resolution: "4K",
					output_format: "png",
				},
			},
		],
		[
			"GPT Image 1.5 medium",
			"gpt-image-1-5-medium",
			"gpt-image/1.5-image-to-image",
			"1:1",
			{
				model: "gpt-image/1.5-image-to-image",
				input: {
					input_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "1:1",
					quality: "medium",
				},
			},
		],
		[
			"GPT Image 1.5 high",
			"gpt-image-1-5-high",
			"gpt-image/1.5-image-to-image",
			"2:3",
			{
				model: "gpt-image/1.5-image-to-image",
				input: {
					input_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "2:3",
					quality: "high",
				},
			},
		],
		[
			"GPT Image 2 1K",
			"gpt-image-2-1k",
			"gpt-image-2-image-to-image",
			"auto",
			{
				model: "gpt-image-2-image-to-image",
				input: {
					input_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "auto",
					resolution: "1K",
					background: "opaque",
				},
			},
		],
		[
			"Seedream 4.5 basic",
			"seedream-4-5-basic-2k",
			"seedream/4.5-edit",
			"4:3",
			{
				model: "seedream/4.5-edit",
				input: {
					image_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "4:3",
					quality: "basic",
					nsfw_checker: true,
				},
			},
		],
		[
			"Seedream 4.5 high",
			"seedream-4-5-high-4k",
			"seedream/4.5-edit",
			"9:16",
			{
				model: "seedream/4.5-edit",
				input: {
					image_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "9:16",
					quality: "high",
					nsfw_checker: true,
				},
			},
		],
		[
			"Seedream 5 Lite basic",
			"seedream-5-lite-basic-2k",
			"seedream/5-lite-image-to-image",
			"16:9",
			{
				model: "seedream/5-lite-image-to-image",
				input: {
					image_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "16:9",
					quality: "basic",
					output_format: "png",
					nsfw_checker: true,
				},
			},
		],
		[
			"Seedream 5 Lite high",
			"seedream-5-lite-high-3k",
			"seedream/5-lite-image-to-image",
			"16:9",
			{
				model: "seedream/5-lite-image-to-image",
				input: {
					image_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "16:9",
					quality: "high",
					output_format: "png",
					nsfw_checker: true,
				},
			},
		],
		[
			"Seedream 5 Lite ultra",
			"seedream-5-lite-ultra-4k",
			"seedream/5-lite-image-to-image",
			"16:9",
			{
				model: "seedream/5-lite-image-to-image",
				input: {
					image_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "16:9",
					quality: "ultra",
					output_format: "png",
					nsfw_checker: true,
				},
			},
		],
		[
			"GPT Image 2 2K",
			"gpt-image-2-2k",
			"gpt-image-2-image-to-image",
			"1:1",
			{
				model: "gpt-image-2-image-to-image",
				input: {
					input_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "1:1",
					resolution: "2K",
				},
			},
		],
		[
			"GPT Image 2 4K",
			"gpt-image-2-4k",
			"gpt-image-2-image-to-image",
			"16:9",
			{
				model: "gpt-image-2-image-to-image",
				input: {
					input_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "16:9",
					resolution: "4K",
				},
			},
		],
		[
			"Seedream 5 Pro basic",
			"seedream-5-pro-basic-1k",
			"seedream/5-pro-image-to-image",
			"4:3",
			{
				model: "seedream/5-pro-image-to-image",
				input: {
					image_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "4:3",
					quality: "basic",
					output_format: "png",
					nsfw_checker: true,
				},
			},
		],
		[
			"Seedream 5 Pro high",
			"seedream-5-pro-high-2k",
			"seedream/5-pro-image-to-image",
			"9:16",
			{
				model: "seedream/5-pro-image-to-image",
				input: {
					image_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "9:16",
					quality: "high",
					output_format: "png",
					nsfw_checker: true,
				},
			},
		],
	] as const)(
		"maps the %s SKU to the exact Kie image request",
		async (_label, skuKey, providerModelId, aspectRatio, expectedBody) => {
			const captured: CapturedRequest[] = [];
			const adapter = new KieProviderAdapter({
				apiKey: "key",
				fetch: capturingFetch(kieFixtures.accepted, captured),
			});

			const submission = await adapter.submit({
				attemptId: "attempt-image-1",
				providerModelId,
				input: {
					kind: "image-to-image",
					prompt: "Restyle the product photo",
					sourceAsset,
					skuKey,
					aspectRatio,
				},
			});

			expect(captured[0]?.url).toBe("https://api.kie.ai/api/v1/jobs/createTask");
			expect(parseCapturedBody(captured)).toEqual(expectedBody);
			expect(submission).toMatchObject({
				providerTaskId: "kie-1",
				status: "QUEUED",
				outcome: "accepted",
				reconciliation: {
					submissionToken: "attempt-image-1",
					statusUrl: "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=kie-1",
				},
			});
		},
	);

	it.each([
		[
			"Nano Banana JPEG",
			"nano-banana-default",
			"google/nano-banana-edit",
			{ outputFormat: "jpeg" },
			{
				model: "google/nano-banana-edit",
				input: {
					image_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "1:1",
					output_format: "jpeg",
					nsfw_checker: true,
				},
			},
		],
		[
			"Nano Banana 2 PNG",
			"nano-banana-2-2k",
			"nano-banana-2",
			{ outputFormat: "png" },
			{
				model: "nano-banana-2",
				input: {
					image_input: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "1:1",
					resolution: "2K",
					output_format: "png",
				},
			},
		],
		[
			"Nano Banana Pro JPEG",
			"nano-banana-pro-4k",
			"nano-banana-pro",
			{ outputFormat: "jpeg" },
			{
				model: "nano-banana-pro",
				input: {
					image_input: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "1:1",
					resolution: "4K",
					output_format: "jpg",
				},
			},
		],
		[
			"Seedream 5 Lite JPEG",
			"seedream-5-lite-ultra-4k",
			"seedream/5-lite-image-to-image",
			{ outputFormat: "jpeg" },
			{
				model: "seedream/5-lite-image-to-image",
				input: {
					image_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "1:1",
					quality: "ultra",
					output_format: "jpeg",
					nsfw_checker: true,
				},
			},
		],
		[
			"Seedream 5 Pro JPEG",
			"seedream-5-pro-high-2k",
			"seedream/5-pro-image-to-image",
			{ outputFormat: "jpeg" },
			{
				model: "seedream/5-pro-image-to-image",
				input: {
					image_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "1:1",
					quality: "high",
					output_format: "jpeg",
					nsfw_checker: true,
				},
			},
		],
		[
			"GPT Image 2 transparent background",
			"gpt-image-2-1k",
			"gpt-image-2-image-to-image",
			{ background: "transparent" },
			{
				model: "gpt-image-2-image-to-image",
				input: {
					input_urls: [sourceAsset.transferUrl],
					prompt: "Restyle the product photo",
					aspect_ratio: "1:1",
					resolution: "1K",
					background: "transparent",
				},
			},
		],
	] as const)(
		"maps the %s control through the approved SKU request",
		async (_label, skuKey, providerModelId, controlInput, expectedBody) => {
			const captured: CapturedRequest[] = [];
			const adapter = new KieProviderAdapter({
				apiKey: "key",
				fetch: capturingFetch(kieFixtures.accepted, captured),
			});

			await adapter.submit({
				attemptId: "attempt-control",
				providerModelId,
				input: {
					kind: "image-to-image",
					prompt: "Restyle the product photo",
					sourceAsset,
					skuKey,
					aspectRatio: "1:1",
					...controlInput,
				},
			});

			expect(parseCapturedBody(captured)).toEqual(expectedBody);
		},
	);

	it.each([
		["gpt-image-2-2k", "gpt-image-2-image-to-image", { background: "transparent" }],
		["seedream-4-5-basic-2k", "seedream/4.5-edit", { outputFormat: "jpeg" }],
	] as const)(
		"rejects a control not supported by SKU %s before contacting Kie",
		async (skuKey, providerModelId, controlInput) => {
			const adapter = new KieProviderAdapter({
				apiKey: "key",
				fetch: (async () => {
					throw new Error("Kie must not be contacted for an unsupported control");
				}) as typeof fetch,
			});

			await expect(
				adapter.submit({
					attemptId: "attempt-rejected-control",
					providerModelId,
					input: {
						kind: "image-to-image",
						prompt: "x",
						sourceAsset,
						skuKey,
						aspectRatio: "1:1",
						...controlInput,
					},
				}),
			).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", retryable: false });
		},
	);

	it.each([
		["an unknown model", "nano-banana-2-lite-1k", "attacker/unknown-model"],
		["a mismatched model and SKU", "gpt-image-2-2k", "nano-banana-2-lite"],
	] as const)("rejects %s before contacting Kie", async (_label, skuKey, providerModelId) => {
		const adapter = new KieProviderAdapter({
			apiKey: "key",
			fetch: (async () => {
				throw new Error("Kie must not be contacted for an unsupported route");
			}) as typeof fetch,
		});

		await expect(
			adapter.submit({
				attemptId: "attempt-rejected",
				providerModelId,
				input: {
					kind: "image-to-image",
					prompt: "x",
					sourceAsset,
					skuKey,
					aspectRatio: "1:1",
				},
			}),
		).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", retryable: false });
	});

	it("requires a server-resolved aspect ratio before contacting Kie", async () => {
		const adapter = new KieProviderAdapter({
			apiKey: "key",
			fetch: (async () => {
				throw new Error("Kie must not be contacted without an approved aspect ratio");
			}) as typeof fetch,
		});

		await expect(
			adapter.submit({
				attemptId: "attempt-missing-aspect-ratio",
				providerModelId: "nano-banana-2-lite",
				input: {
					kind: "image-to-image",
					prompt: "x",
					sourceAsset,
					skuKey: "nano-banana-2-lite-1k",
				},
			}),
		).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", retryable: false });
	});

	it.each([
		["missing business code", { data: { taskId: "kie-1" } }],
		["missing task id", { code: 200, data: {} }],
	] as const)("does not accept a 2xx create response with %s", async (_label, body) => {
		const adapter = new KieProviderAdapter({
			apiKey: "key",
			fetch: capturingFetch(body, []),
		});
		await expect(
			adapter.submit({
				attemptId: "attempt-malformed",
				providerModelId: "nano-banana-2-lite",
				input: {
					kind: "image-to-image",
					prompt: "x",
					sourceAsset,
					skuKey: "nano-banana-2-lite-1k",
					aspectRatio: "1:1",
				},
			}),
		).rejects.toMatchObject({ code: "MALFORMED_PROVIDER_RESPONSE", retryable: false });
	});

	it.each([
		["waiting", kieFixtures.imageWaiting, "QUEUED"],
		["queuing", kieFixtures.imageQueuing, "QUEUED"],
		["generating", kieFixtures.imageGenerating, "RUNNING"],
		["success", kieFixtures.imageSucceeded, "SUCCEEDED"],
		["fail", kieFixtures.imageFailed, "FAILED"],
	] as const)("maps Kie common job state %s", async (_state, body, expectedStatus) => {
		const captured: CapturedRequest[] = [];
		const statusUrl = "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=kie-image-1";
		const adapter = new KieProviderAdapter({
			apiKey: "key",
			fetch: capturingFetch(body, captured),
		});

		const snapshot = await adapter.retrieve({ providerTaskId: "kie-image-1", statusUrl });
		expect(captured[0]?.url).toBe(statusUrl);
		expect(snapshot.status).toBe(expectedStatus);

		if (expectedStatus === "SUCCEEDED") {
			const normalized = await adapter.normalizeResult(snapshot);
			expect(normalized).toMatchObject({
				outputs: [
					{
						kind: "remote-url",
						url: "https://cdn.test/image-1.png",
						trust: "untrusted-transfer-candidate",
					},
				],
				providerCostMicros: 80_000,
				providerCharged: true,
			});
			expect(normalized.outputs).toHaveLength(1);
		}
		if (expectedStatus === "FAILED") {
			expect(await adapter.normalizeResult(snapshot)).toMatchObject({
				failure: { code: "PROVIDER_TEMPORARY", message: "temporarily unavailable" },
				providerCostMicros: 0,
				providerCharged: false,
			});
		}
	});

	it("rejects a Kie status URL that was not derived by this adapter", async () => {
		const adapter = new KieProviderAdapter({
			apiKey: "key",
			fetch: capturingFetch(kieFixtures.imageWaiting, []),
		});
		await expect(
			adapter.retrieve({
				providerTaskId: "kie-image-1",
				statusUrl: "https://attacker.test/steal-kie-authorization",
			}),
		).rejects.toMatchObject({ code: "MALFORMED_PROVIDER_RESPONSE", retryable: false });
	});

	it("rejects a common job response for a different task id", async () => {
		const adapter = new KieProviderAdapter({
			apiKey: "key",
			fetch: capturingFetch(
				{
					...kieFixtures.imageWaiting,
					data: { ...kieFixtures.imageWaiting.data, taskId: "different-task" },
				},
				[],
			),
		});
		await expect(
			adapter.retrieve({
				providerTaskId: "kie-image-1",
				statusUrl: "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=kie-image-1",
			}),
		).rejects.toMatchObject({ code: "MALFORMED_PROVIDER_RESPONSE", retryable: false });
	});

	it("uses failCode when a failed common job omits failMsg", async () => {
		const statusUrl = "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=kie-image-1";
		const adapter = new KieProviderAdapter({
			apiKey: "key",
			fetch: capturingFetch(kieFixtures.imageFailedCodeOnly, []),
		});
		const snapshot = await adapter.retrieve({ providerTaskId: "kie-image-1", statusUrl });
		await expect(adapter.normalizeResult(snapshot)).resolves.toMatchObject({
			failure: { code: "PROVIDER_REJECTED", message: "CONTENT_POLICY_REJECTED" },
		});
	});

	it("normalizes fractional Kie credits without rejecting a valid job record", async () => {
		const statusUrl = "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=kie-image-1";
		const adapter = new KieProviderAdapter({
			apiKey: "key",
			fetch: capturingFetch(
				{
					...kieFixtures.imageSucceeded,
					data: { ...kieFixtures.imageSucceeded.data, creditsConsumed: 5.5 },
				},
				[],
			),
		});
		const snapshot = await adapter.retrieve({ providerTaskId: "kie-image-1", statusUrl });

		await expect(adapter.normalizeResult(snapshot)).resolves.toMatchObject({
			providerCostMicros: 27_500,
			providerCharged: true,
		});
	});

	it("rejects multiple Kie image outputs instead of widening a one-output SKU", async () => {
		const statusUrl = "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=kie-image-1";
		const adapter = new KieProviderAdapter({
			apiKey: "key",
			fetch: capturingFetch(kieFixtures.imageSucceededWithMultipleOutputs, []),
		});
		const snapshot = await adapter.retrieve({ providerTaskId: "kie-image-1", statusUrl });

		await expect(adapter.normalizeResult(snapshot)).rejects.toMatchObject({
			code: "MALFORMED_PROVIDER_RESPONSE",
			retryable: false,
		});
	});

	it("keeps legacy Veo retrieval on the Veo record-info endpoint", async () => {
		const captured: CapturedRequest[] = [];
		const adapter = new KieProviderAdapter({
			apiKey: "key",
			fetch: capturingFetch(kieFixtures.succeeded, captured),
		});
		await expect(adapter.retrieve({ providerTaskId: "kie-video-1" })).resolves.toMatchObject({
			status: "SUCCEEDED",
		});
		expect(captured[0]?.url).toBe("https://api.kie.ai/api/v1/veo/record-info?taskId=kie-video-1");
	});
});
