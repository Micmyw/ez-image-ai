import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import falFixtures from "./fixtures/fal.json";
import geminiFixtures from "./fixtures/gemini.json";
import kieFixtures from "./fixtures/kie.json";
import replicateFixtures from "./fixtures/replicate.json";
import {
	FalProviderAdapter,
	GeminiProviderAdapter,
	KieProviderAdapter,
	ReplicateProviderAdapter,
} from "./index";

interface FetchFixture {
	status?: number;
	body: unknown;
}

function fixtureFetch(...fixtures: FetchFixture[]): typeof fetch {
	let index = 0;
	return (async () => {
		const fixture = fixtures[index++];
		if (!fixture) throw new Error("Unexpected HTTP request");
		return new Response(JSON.stringify(fixture.body), {
			status: fixture.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

function capturingFetch(
	body: unknown,
	captured: Array<{ url: string; init?: RequestInit }>,
): typeof fetch {
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

function parseCapturedBody(captured: Array<{ url: string; init?: RequestInit }>): unknown {
	const body = captured[0]?.init?.body;
	if (typeof body !== "string") throw new Error("Expected a string request body");
	return JSON.parse(body) as unknown;
}

describe("provider adapter contract", () => {
	it("marks unsupported asynchronous Gemini fixture states as not applicable", () => {
		for (const state of ["queued", "running", "canceled"] as const) {
			expect(geminiFixtures[state]).toMatchObject({
				applicability: "not-applicable",
				protocol: "synchronous",
			});
		}
	});

	it.each([
		["accepted", geminiFixtures.accepted, 1],
		["succeeded-multiple-output", geminiFixtures.succeeded, 2],
	] as const)(
		"consumes Gemini %s fixture and normalizes outputs",
		async (_case, fixture, outputCount) => {
			const adapter = new GeminiProviderAdapter({
				apiKey: "key",
				fetch: fixtureFetch({ body: fixture }),
			});
			const submission = await adapter.submit({
				attemptId: "gemini-fixture",
				providerModelId: "gemini-route",
				input: { kind: "text-to-image", prompt: "x" },
			});
			expect(submission).toMatchObject({
				providerTaskId: "gemini-fixture",
				status: "SUCCEEDED",
				acceptance: "CERTAIN",
			});
			const result = await adapter.normalizeResult(submission.snapshot!);
			expect(result.outputs).toHaveLength(outputCount);
			expect(
				result.outputs.every(
					(output) =>
						output.kind === "inline-base64" && output.trust === "untrusted-transfer-candidate",
				),
			).toBe(true);
		},
	);

	it("preserves a non-JSON HTTP rejection body without treating it as transport uncertainty", async () => {
		const adapter = new ReplicateProviderAdapter({
			apiToken: "token",
			fetch: (async () =>
				new Response("rate limited by provider", {
					status: 429,
					headers: { "content-type": "text/plain" },
				})) as typeof fetch,
		});
		await expect(
			adapter.submit({
				attemptId: "http-text",
				providerModelId: "route",
				input: { kind: "text-to-image", prompt: "x" },
			}),
		).resolves.toMatchObject({
			status: "FAILED",
			acceptance: "CERTAIN",
			failure: { code: "HTTP_429", message: "rate limited by provider", retryable: true },
		});
	});

	it("consumes Kie unknown retrieval fixture as an unknown response", async () => {
		const adapter = new KieProviderAdapter({
			apiKey: "key",
			fetch: fixtureFetch({ status: 503, body: kieFixtures.unknownSubmission }),
		});
		await expect(adapter.retrieve({ providerTaskId: "kie-unknown" })).resolves.toEqual({
			providerTaskId: "kie-unknown",
			status: "UNKNOWN",
			raw: kieFixtures.unknownSubmission,
		});
	});

	it.each([
		[
			"replicate",
			replicateFixtures,
			(body: unknown) =>
				new ReplicateProviderAdapter({ apiToken: "token", fetch: fixtureFetch({ body }) }),
			undefined,
		],
		[
			"fal",
			falFixtures,
			(body: unknown) => new FalProviderAdapter({ apiKey: "key", fetch: fixtureFetch({ body }) }),
			"https://queue.fal.run/result",
		],
		[
			"kie",
			kieFixtures,
			(body: unknown) => new KieProviderAdapter({ apiKey: "key", fetch: fixtureFetch({ body }) }),
			undefined,
		],
	] as const)(
		"loads %s fixtures for queued, running, success, failures, and canceled",
		async (_provider, fixtures, create, resultUrl) => {
			for (const [fixtureName, expected] of [
				["queued", "QUEUED"],
				["running", "RUNNING"],
				["succeeded", "SUCCEEDED"],
				["failedRetryable", "FAILED"],
				["failedTerminal", "FAILED"],
				["canceled", "CANCELED"],
			] as const) {
				const adapter = create(fixtures[fixtureName]);
				const snapshot = await adapter.retrieve({ providerTaskId: "fixture-task", resultUrl });
				expect(snapshot.status, fixtureName).toBe(expected);
				if (expected === "FAILED") {
					const result = await adapter.normalizeResult(snapshot);
					expect(result.failure?.retryable).toBe(fixtureName === "failedRetryable");
				}
				if (expected === "SUCCEEDED")
					expect((await adapter.normalizeResult(snapshot)).outputs).toHaveLength(2);
			}
		},
	);

	it("loads malformed and rejected submission fixtures without live network", async () => {
		await expect(
			new ReplicateProviderAdapter({
				apiToken: "token",
				fetch: fixtureFetch({ body: replicateFixtures.malformed }),
			}).submit({
				attemptId: "a",
				providerModelId: "route",
				input: { kind: "text-to-image", prompt: "x" },
			}),
		).rejects.toMatchObject({ code: "MALFORMED_PROVIDER_RESPONSE" });
		await expect(
			new FalProviderAdapter({
				apiKey: "key",
				fetch: fixtureFetch({ body: falFixtures.malformed }),
			}).submit({
				attemptId: "a",
				providerModelId: "route",
				input: { kind: "text-to-image", prompt: "x" },
			}),
		).rejects.toMatchObject({ code: "MALFORMED_PROVIDER_RESPONSE" });
		await expect(
			new KieProviderAdapter({
				apiKey: "key",
				fetch: fixtureFetch({ body: kieFixtures.malformed }),
			}).retrieve({ providerTaskId: "a" }),
		).rejects.toMatchObject({ code: "MALFORMED_PROVIDER_RESPONSE" });
		await expect(
			new GeminiProviderAdapter({
				apiKey: "key",
				fetch: fixtureFetch({ body: geminiFixtures.malformed }),
			}).submit({
				attemptId: "a",
				providerModelId: "route",
				input: { kind: "text-to-image", prompt: "x" },
			}),
		).rejects.toMatchObject({ code: "MALFORMED_PROVIDER_RESPONSE" });
		for (const [adapter, fixture] of [
			[
				new ReplicateProviderAdapter({
					apiToken: "token",
					fetch: fixtureFetch({ status: 503, body: replicateFixtures.unknownSubmission }),
				}),
				replicateFixtures,
			],
			[
				new FalProviderAdapter({
					apiKey: "key",
					fetch: fixtureFetch({ status: 503, body: falFixtures.unknownSubmission }),
				}),
				falFixtures,
			],
			[
				new GeminiProviderAdapter({
					apiKey: "key",
					fetch: fixtureFetch({ status: 503, body: geminiFixtures.unknownSubmission }),
				}),
				geminiFixtures,
			],
		] as const) {
			void fixture;
			await expect(
				adapter.submit({
					attemptId: "unknown",
					providerModelId: "route",
					input: { kind: "text-to-image", prompt: "x" },
				}),
			).resolves.toMatchObject({
				acceptance: "CERTAIN",
				status: "FAILED",
				reconciliation: { submissionToken: "unknown" },
			});
		}
		const replicateUnknown = await new ReplicateProviderAdapter({
			apiToken: "token",
			fetch: fixtureFetch({ status: 503, body: replicateFixtures.unknownSubmission }),
		}).submit({
			attemptId: "not-a-provider-task",
			providerModelId: "route",
			input: { kind: "text-to-image", prompt: "x" },
		});
		const falUnknown = await new FalProviderAdapter({
			apiKey: "key",
			fetch: fixtureFetch({ status: 503, body: falFixtures.unknownSubmission }),
		}).submit({
			attemptId: "not-a-provider-task",
			providerModelId: "route",
			input: { kind: "text-to-image", prompt: "x" },
		});
		expect(replicateUnknown.providerTaskId).toBeUndefined();
		expect(falUnknown.providerTaskId).toBeUndefined();
	});
	it("verifies Svix-style Replicate webhooks with fresh multi-signatures", async () => {
		const key = randomBytes(32);
		const secret = `whsec_${key.toString("base64")}`;
		const body = JSON.stringify({
			id: "task-webhook",
			status: "succeeded",
			created_at: "2026-08-14T00:00:00.000Z",
			started_at: "2026-08-14T00:00:05.000Z",
			completed_at: "2026-08-14T00:00:10.000Z",
		});
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const signed = `msg-1.${timestamp}.${body}`;
		const valid = createHmac("sha256", key).update(signed).digest("base64");
		const adapter = new ReplicateProviderAdapter({ apiToken: "token", webhookSecret: secret });
		const request = new Request("https://app.test/webhook", {
			method: "POST",
			body,
			headers: {
				"webhook-id": "msg-1",
				"webhook-timestamp": timestamp,
				"webhook-signature": `v1,${Buffer.alloc(32).toString("base64")} v1,${valid}`,
			},
		});
		await expect(adapter.verifyWebhook(request)).resolves.toMatchObject({
			eventId: "msg-1",
			providerTaskId: "task-webhook",
			status: "SUCCEEDED",
			providerOccurredAt: new Date("2026-08-14T00:00:10.000Z"),
		});
	});

	it.each([
		["invalid", 0, "v1,AAAA"],
		["stale", -600, null],
		["future replay", 600, null],
	])("rejects %s Svix-style Replicate webhooks", async (_label, offset, override) => {
		const key = randomBytes(32);
		const secret = `whsec_${key.toString("base64")}`;
		const body = JSON.stringify({ id: "task-webhook", status: "succeeded" });
		const timestamp = (Math.floor(Date.now() / 1000) + offset).toString();
		const valid = createHmac("sha256", key).update(`msg-1.${timestamp}.${body}`).digest("base64");
		const adapter = new ReplicateProviderAdapter({ apiToken: "token", webhookSecret: secret });
		const request = new Request("https://app.test/webhook", {
			method: "POST",
			body,
			headers: {
				"webhook-id": "msg-1",
				"webhook-timestamp": timestamp,
				"webhook-signature": override ?? `v1,${valid}`,
			},
		});
		await expect(adapter.verifyWebhook(request)).rejects.toMatchObject({
			code: "WEBHOOK_VERIFICATION_FAILED",
		});
	});
	it("normalizes accepted, running, multiple output, retryable, terminal, and canceled snapshots", async () => {
		const adapter = new ReplicateProviderAdapter({
			apiToken: "test-token",
			webhookSecret: "test-webhook",
			fetch: fixtureFetch(
				{ body: { id: "task-1", status: "starting" } },
				{ body: { id: "task-1", status: "processing", metrics: { predict_time: 1 } } },
				{
					body: {
						id: "task-1",
						status: "succeeded",
						output: ["https://cdn.test/1.png", "https://cdn.test/2.png"],
						metrics: { predict_time: 2.5 },
					},
				},
				{ body: { id: "task-2", status: "failed", error: "rate limit exceeded" } },
				{ body: { id: "task-3", status: "failed", error: "invalid prompt" } },
				{ body: { id: "task-4", status: "canceled" } },
			),
		});

		const submission = await adapter.submit({
			attemptId: "attempt-1",
			providerModelId: "owner/model:version",
			input: { kind: "text-to-image", prompt: "A lighthouse" },
			webhookUrl: "https://app.test/webhooks/replicate",
		});
		expect(submission).toMatchObject({
			providerTaskId: "task-1",
			status: "QUEUED",
			acceptance: "CERTAIN",
		});

		const running = await adapter.retrieve({ providerTaskId: "task-1" });
		expect(running.status).toBe("RUNNING");

		const succeeded = await adapter.retrieve({ providerTaskId: "task-1" });
		const result = await adapter.normalizeResult(succeeded);
		expect(result.outputs).toEqual([
			{ kind: "remote-url", url: "https://cdn.test/1.png", trust: "untrusted-transfer-candidate" },
			{ kind: "remote-url", url: "https://cdn.test/2.png", trust: "untrusted-transfer-candidate" },
		]);
		expect(result.providerCharged).toBe(true);
		expect(result.providerCostMicros).toBeGreaterThan(0);

		const retryable = await adapter.normalizeResult(
			await adapter.retrieve({ providerTaskId: "task-2" }),
		);
		expect(retryable.failure).toMatchObject({ retryable: true });

		const terminal = await adapter.normalizeResult(
			await adapter.retrieve({ providerTaskId: "task-3" }),
		);
		expect(terminal.failure).toMatchObject({ retryable: false });

		const canceled = await adapter.retrieve({ providerTaskId: "task-4" });
		expect(canceled.status).toBe("CANCELED");
	});

	it("rejects malformed responses and normalizes HTTP rejections", async () => {
		const malformed = new ReplicateProviderAdapter({
			apiToken: "token",
			fetch: fixtureFetch({ body: { status: "starting" } }),
		});
		await expect(
			malformed.submit({
				attemptId: "a",
				providerModelId: "model",
				input: { kind: "text-to-image", prompt: "x" },
			}),
		).rejects.toMatchObject({ code: "MALFORMED_PROVIDER_RESPONSE" });

		const unknown = new ReplicateProviderAdapter({
			apiToken: "token",
			fetch: fixtureFetch({ status: 503, body: { detail: "unavailable" } }),
		});
		await expect(
			unknown.submit({
				attemptId: "a",
				providerModelId: "model",
				input: { kind: "text-to-image", prompt: "x" },
			}),
		).resolves.toMatchObject({
			acceptance: "CERTAIN",
			status: "FAILED",
			failure: { code: "HTTP_503", retryable: true },
		});
	});

	it.each([
		["replicate", 429, true],
		["replicate", 400, false],
		["fal", 503, true],
		["fal", 422, false],
	] as const)(
		"normalizes %s HTTP %s submission rejection as certain (retryable=%s)",
		async (provider, status, retryable) => {
			const adapter =
				provider === "replicate"
					? new ReplicateProviderAdapter({
							apiToken: "token",
							fetch: fixtureFetch({ status, body: { detail: "provider rejected request" } }),
						})
					: new FalProviderAdapter({
							apiKey: "key",
							fetch: fixtureFetch({ status, body: { detail: "provider rejected request" } }),
						});

			const submission = await adapter.submit({
				attemptId: `http-${status}`,
				providerModelId: "route",
				input: { kind: "text-to-image", prompt: "x" },
			});
			expect(submission).toMatchObject({
				status: "FAILED",
				acceptance: "CERTAIN",
				failure: { code: `HTTP_${status}`, retryable },
			});
			expect(submission.providerTaskId).toBeUndefined();
		},
	);

	it("submits Kie video jobs with the server-resolved input and a stable attempt id", async () => {
		const captured: Array<{ url: string; init?: RequestInit }> = [];
		const kie = new KieProviderAdapter({
			apiKey: "key",
			fetch: capturingFetch({ data: { taskId: "kie-1", state: "waiting" } }, captured),
		});
		await expect(
			kie.submit({
				attemptId: "attempt-1",
				providerModelId: "veo3",
				input: {
					kind: "image-to-video",
					prompt: "A product reveal",
					sourceAsset: {
						assetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
						transferUrl: "https://transfer.test/source.png",
					},
					durationSeconds: 8,
				},
			}),
		).resolves.toMatchObject({
			providerTaskId: "kie-1",
			status: "QUEUED",
			acceptance: "CERTAIN",
			idempotency: { key: "attempt-1", replayed: false },
		});
		expect(captured[0]?.url).toBe("https://api.kie.ai/api/v1/veo/generate");
		expect(captured[0]?.init?.headers).not.toHaveProperty("X-Idempotency-Key");
		expect(parseCapturedBody(captured)).toEqual({
			model: "veo3",
			prompt: "A product reveal",
			imageUrls: ["https://transfer.test/source.png"],
			duration: 8,
		});
	});

	it.each([
		[429, true],
		[500, true],
		[422, false],
	] as const)(
		"normalizes a Kie business code %s without requiring a task id (retryable=%s)",
		async (code, retryable) => {
			const kie = new KieProviderAdapter({
				apiKey: "key",
				fetch: fixtureFetch({ body: { code, msg: "provider business rejection", data: null } }),
			});
			await expect(
				kie.submit({
					attemptId: `kie-business-${code}`,
					providerModelId: "veo3",
					input: { kind: "text-to-video", prompt: "x", durationSeconds: 8 },
				}),
			).resolves.toMatchObject({
				status: "FAILED",
				acceptance: "CERTAIN",
				failure: { code: `HTTP_${code}`, retryable },
			});
		},
	);

	it("normalizes Kie Veo record-info success and failure contracts", async () => {
		const succeeded = new KieProviderAdapter({
			apiKey: "key",
			fetch: fixtureFetch({ body: kieFixtures.succeeded }),
		});
		const successSnapshot = await succeeded.retrieve({ providerTaskId: "kie-1" });
		expect(successSnapshot.status).toBe("SUCCEEDED");
		expect((await succeeded.normalizeResult(successSnapshot)).outputs).toHaveLength(2);

		const failed = new KieProviderAdapter({
			apiKey: "key",
			fetch: fixtureFetch({ body: kieFixtures.failedRetryable }),
		});
		const failureSnapshot = await failed.retrieve({ providerTaskId: "kie-2" });
		expect(failureSnapshot.status).toBe("FAILED");
		expect(await failed.normalizeResult(failureSnapshot)).toMatchObject({
			failure: { retryable: true },
		});
	});

	it("uses Kie reconciliation and only assigns Gemini attempt IDs on completion", async () => {
		const kie = new KieProviderAdapter({
			apiKey: "key",
			fetch: fixtureFetch({
				body: {
					data: { taskId: "kie-1", state: "success", resultUrls: ["https://cdn.test/video.mp4"] },
				},
			}),
		});
		expect((await kie.retrieve({ providerTaskId: "kie-1" })).status).toBe("SUCCEEDED");

		const gemini = new GeminiProviderAdapter({
			apiKey: "key",
			fetch: fixtureFetch({
				body: {
					candidates: [
						{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] } },
					],
				},
			}),
		});
		const submission = await gemini.submit({
			attemptId: "attempt-stable",
			providerModelId: "gemini-image",
			input: { kind: "text-to-image", prompt: "x" },
		});
		expect(submission.providerTaskId).toBe("attempt-stable");
		const output = (await gemini.normalizeResult(submission.snapshot!)).outputs[0];
		expect(output).toEqual({
			kind: "inline-base64",
			mimeType: "image/png",
			data: "aGVsbG8=",
			trust: "untrusted-transfer-candidate",
		});
		await expect(gemini.retrieve({ providerTaskId: "attempt-stable" })).resolves.toEqual({
			providerTaskId: "attempt-stable",
			status: "UNKNOWN",
			raw: null,
		});
		const replacementWorker = new GeminiProviderAdapter({
			apiKey: "key",
			fetch: fixtureFetch({ body: geminiFixtures.succeeded }),
		});
		await expect(replacementWorker.retrieve({ providerTaskId: "attempt-stable" })).resolves.toEqual(
			{ providerTaskId: "attempt-stable", status: "UNKNOWN", raw: null },
		);
	});

	it("stores and uses explicit Fal status and result endpoints", async () => {
		const fal = new FalProviderAdapter({
			apiKey: "key",
			fetch: fixtureFetch(
				{
					body: {
						request_id: "fal-1",
						status: "IN_QUEUE",
						status_url: "https://queue.fal.run/fal-1/status",
						response_url: "https://queue.fal.run/fal-1/result",
					},
				},
				{
					body: {
						request_id: "fal-1",
						status: "COMPLETED",
						images: [{ url: "https://cdn.test/1.png" }, { url: "https://cdn.test/2.png" }],
					},
				},
			),
		});
		const submission = await fal.submit({
			attemptId: "fal-attempt",
			providerModelId: "fal-ai/model",
			input: { kind: "text-to-image", prompt: "x" },
		});
		expect(submission.snapshot?.raw).toMatchObject({
			status_url: "https://queue.fal.run/fal-1/status",
			response_url: "https://queue.fal.run/fal-1/result",
		});
		expect(submission.reconciliation).toEqual({
			statusUrl: "https://queue.fal.run/fal-1/status",
			resultUrl: "https://queue.fal.run/fal-1/result",
			submissionToken: "fal-attempt",
		});
		const result = await fal.normalizeResult(
			await fal.retrieve({
				providerTaskId: "fal-1",
				resultUrl: "https://queue.fal.run/fal-1/result",
			}),
		);
		expect(result.outputs).toHaveLength(2);
	});

	it.each([
		[
			"text-to-image",
			{ kind: "text-to-image", prompt: "x", width: 1024, height: 768 },
			{ prompt: "x", width: 1024, height: 768 },
		],
		[
			"image-to-image",
			{
				kind: "image-to-image",
				prompt: "x",
				sourceAsset: {
					assetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
					transferUrl: "https://transfer.test/source.png",
				},
				strength: 0.6,
			},
			{ prompt: "x", image: "https://transfer.test/source.png", strength: 0.6 },
		],
		[
			"text-to-video",
			{ kind: "text-to-video", prompt: "x", durationSeconds: 5 },
			{ prompt: "x", duration: 5 },
		],
		[
			"image-to-video",
			{
				kind: "image-to-video",
				prompt: "x",
				sourceAsset: {
					assetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
					transferUrl: "https://transfer.test/source.png",
				},
				durationSeconds: 6,
			},
			{ prompt: "x", image: "https://transfer.test/source.png", duration: 6 },
		],
	] as const)("maps Replicate %s execution input", async (_kind, input, expected) => {
		const captured: Array<{ url: string; init?: RequestInit }> = [];
		const adapter = new ReplicateProviderAdapter({
			apiToken: "token",
			fetch: capturingFetch({ id: "r-1", status: "starting" }, captured),
		});
		await adapter.submit({ attemptId: "a", providerModelId: "route-model", input });
		expect(parseCapturedBody(captured)).toMatchObject({
			version: "route-model",
			input: expected,
		});
	});

	it("maps Fal duration and resolved image, and Gemini includes resolved inline source", async () => {
		const falCaptured: Array<{ url: string; init?: RequestInit }> = [];
		const fal = new FalProviderAdapter({
			apiKey: "key",
			fetch: capturingFetch({ request_id: "f-1", status: "IN_QUEUE" }, falCaptured),
		});
		await fal.submit({
			attemptId: "a",
			providerModelId: "fal-route",
			input: {
				kind: "image-to-video",
				prompt: "x",
				sourceAsset: {
					assetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
					transferUrl: "https://transfer.test/source.png",
				},
				durationSeconds: 7,
			},
		});
		expect(parseCapturedBody(falCaptured)).toEqual({
			prompt: "x",
			image_url: "https://transfer.test/source.png",
			duration: 7,
		});

		const geminiCaptured: Array<{ url: string; init?: RequestInit }> = [];
		const gemini = new GeminiProviderAdapter({
			apiKey: "key",
			fetch: capturingFetch(
				{
					candidates: [
						{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aA==" } }] } },
					],
				},
				geminiCaptured,
			),
		});
		await gemini.submit({
			attemptId: "a",
			providerModelId: "gemini-route",
			input: {
				kind: "image-to-image",
				prompt: "x",
				sourceAsset: {
					assetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
					transferUrl: "data:image/png;base64,aGVsbG8=",
				},
				strength: 0.5,
			},
		});
		expect(parseCapturedBody(geminiCaptured)).toMatchObject({
			contents: [
				{ parts: [{ text: "x" }, { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] },
			],
		});
	});
});
