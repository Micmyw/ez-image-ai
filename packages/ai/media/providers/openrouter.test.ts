import { describe, expect, it, vi } from "vitest";

import * as providerExports from "./index";

const OpenRouterProviderAdapter = (
	providerExports as typeof providerExports & {
		OpenRouterProviderAdapter: new (options: {
			apiKey: string;
			baseUrl?: string;
			fetch?: typeof fetch;
			timeoutMs?: number;
		}) => import("./provider-adapter").MediaProviderAdapter;
	}
).OpenRouterProviderAdapter;

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString(
	"base64",
);

describe("OpenRouterProviderAdapter", () => {
	it("submits exactly one image edit with bearer auth and the resolved private input reference", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const adapter = new OpenRouterProviderAdapter({
			apiKey: "server-openrouter-key",
			fetch: capturingFetch({ data: [{ b64_json: PNG_BASE64 }] }, requests),
		});

		const submission = await adapter.submit({
			attemptId: "attempt-1",
			providerModelId: "sourceful/riverflow-v2.5-fast",
			input: {
				kind: "image-to-image",
				prompt: "Keep the subject and replace the background",
				sourceAsset: {
					assetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
					transferUrl: "https://private.example.test/signed-input",
				},
			},
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/images");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[0]?.init?.headers).toEqual({
			Authorization: "Bearer server-openrouter-key",
			"Content-Type": "application/json",
		});
		const requestBody = requests[0]?.init?.body;
		expect(typeof requestBody).toBe("string");
		expect(JSON.parse(requestBody as string)).toEqual({
			model: "sourceful/riverflow-v2.5-fast",
			prompt: "Keep the subject and replace the background",
			n: 1,
			input_references: [
				{
					type: "image_url",
					image_url: { url: "https://private.example.test/signed-input" },
				},
			],
		});
		expect(submission).toMatchObject({
			providerTaskId: "attempt-1",
			status: "SUCCEEDED",
			outcome: "accepted",
			idempotency: { providerSupported: false, replayed: false },
		});
		expect(submission.idempotency).not.toHaveProperty("key");
		expect(await adapter.normalizeResult(submission.snapshot!)).toEqual({
			outputs: [
				{
					kind: "inline-base64",
					mimeType: "image/png",
					data: PNG_BASE64,
					trust: "untrusted-transfer-candidate",
				},
			],
			progress: 100,
			providerCostMicros: null,
			failure: null,
			retryable: false,
			providerCharged: true,
		});
	});

	it("accepts official response metadata around one canonical raster result", async () => {
		const response = {
			created: 1_725_000_000,
			usage: { total_tokens: 42 },
			data: [{ b64_json: PNG_BASE64, media_type: "image/png" }],
		};
		const adapter = new OpenRouterProviderAdapter({
			apiKey: "server-openrouter-key",
			fetch: fixtureFetch({ body: response }),
		});

		const submission = await adapter.submit(validSubmitInput());

		expect(submission).toMatchObject({ status: "SUCCEEDED", outcome: "accepted" });
		expect(await adapter.normalizeResult(submission.snapshot!)).toMatchObject({
			outputs: [{ kind: "inline-base64", mimeType: "image/png", data: PNG_BASE64 }],
		});
	});

	it.each([
		[429, "uncertain"],
		[503, "uncertain"],
		[422, "rejected"],
	] as const)("classifies HTTP %s as %s without image idempotency", async (status, outcome) => {
		const adapter = new OpenRouterProviderAdapter({
			apiKey: "server-openrouter-key",
			fetch: fixtureFetch({ status, body: { error: { message: "request failed" } } }),
		});

		await expect(adapter.submit(validSubmitInput())).resolves.toMatchObject({
			status: "FAILED",
			outcome,
			idempotency: { providerSupported: false, replayed: false },
		});
	});

	it.each([
		["multiple outputs", { data: [{ b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }] }],
		["remote output", { data: [{ url: "https://public.example.test/result.png" }] }],
		["malformed base64", { data: [{ b64_json: "not-valid-base64%%%" }] }],
		[
			"metadata for non-raster bytes",
			{
				created: 1_725_000_000,
				usage: { total_tokens: 42 },
				data: [
					{
						b64_json: Buffer.from("not an image").toString("base64"),
						media_type: "image/png",
					},
				],
			},
		],
		["missing output", { data: [] }],
	] as const)("keeps a 2xx %s response uncertain", async (_label, body) => {
		const adapter = new OpenRouterProviderAdapter({
			apiKey: "server-openrouter-key",
			fetch: fixtureFetch({ body }),
		});

		await expect(adapter.submit(validSubmitInput())).resolves.toMatchObject({
			status: "SUCCEEDED",
			outcome: "uncertain",
			uncertainty: { classification: "malformed_2xx", phase: "post_send" },
			idempotency: { providerSupported: false, replayed: false },
		});
	});

	it("keeps transport failures uncertain for the dispatch boundary", async () => {
		const adapter = new OpenRouterProviderAdapter({
			apiKey: "server-openrouter-key",
			fetch: vi.fn(async () => {
				throw new TypeError("socket closed");
			}),
		});

		await expect(adapter.submit(validSubmitInput())).rejects.toMatchObject({
			code: "HTTP_ERROR",
			retryable: true,
		});
	});

	it("uses a separate conservative long timeout and still surfaces expiry as transport uncertainty", async () => {
		vi.useFakeTimers();
		let requestSignal: AbortSignal | undefined;
		const adapter = new OpenRouterProviderAdapter({
			apiKey: "server-openrouter-key",
			fetch: vi.fn(async (_url, init) => {
				requestSignal = init?.signal ?? undefined;
				return await new Promise<Response>((_resolve, reject) => {
					requestSignal?.addEventListener("abort", () => reject(new Error("aborted")));
				});
			}),
		});
		const observed = adapter.submit(validSubmitInput()).then(
			() => null,
			(error: unknown) => error,
		);

		try {
			await vi.advanceTimersByTimeAsync(15_000);
			expect(requestSignal?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(225_000);
			expect(requestSignal?.aborted).toBe(true);
			await expect(observed).resolves.toMatchObject({ code: "HTTP_ERROR", retryable: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects unsupported text-only input before sending a request", async () => {
		const fetcher = vi.fn();
		const adapter = new OpenRouterProviderAdapter({
			apiKey: "server-openrouter-key",
			fetch: fetcher,
		});

		await expect(
			adapter.submit({
				attemptId: "attempt-1",
				providerModelId: "sourceful/riverflow-v2.5-fast",
				input: { kind: "text-to-image", prompt: "Generate a new image" },
			}),
		).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", retryable: false });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("has no cancel contract and retrieval remains unknown", async () => {
		const adapter = new OpenRouterProviderAdapter({ apiKey: "server-openrouter-key" });

		expect("cancel" in adapter).toBe(false);
		await expect(adapter.retrieve({ providerTaskId: "attempt-1" })).resolves.toEqual({
			providerTaskId: "attempt-1",
			status: "UNKNOWN",
			raw: null,
		});
	});
});

function validSubmitInput() {
	return {
		attemptId: "attempt-1",
		providerModelId: "sourceful/riverflow-v2.5-fast",
		input: {
			kind: "image-to-image" as const,
			prompt: "Keep the subject",
			sourceAsset: {
				assetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
				transferUrl: "https://private.example.test/signed-input",
			},
		},
	};
}

function capturingFetch(
	body: unknown,
	requests: Array<{ url: string; init?: RequestInit }>,
): typeof fetch {
	return (async (url: URL | RequestInfo, init?: RequestInit) => {
		requests.push({
			url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
			init,
		});
		return Response.json(body);
	}) as typeof fetch;
}

function fixtureFetch(fixture: { status?: number; body: unknown }): typeof fetch {
	return (async () =>
		Response.json(fixture.body, {
			status: fixture.status ?? 200,
		})) as typeof fetch;
}
