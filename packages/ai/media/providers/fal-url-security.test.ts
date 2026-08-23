import { describe, expect, it } from "vitest";

import { FalProviderAdapter } from "./fal";

interface CapturedRequest {
	url: string;
	init?: RequestInit;
}

function response(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("Fal authenticated endpoint policy", () => {
	it("uses exact official queue endpoints without following redirects", async () => {
		const captured: CapturedRequest[] = [];
		const bodies = [
			{
				request_id: "fal-1",
				status: "IN_QUEUE",
				status_url: "https://queue.fal.run/fal-ai/model/requests/fal-1/status",
				response_url: "https://queue.fal.run/fal-ai/model/requests/fal-1",
			},
			{ request_id: "fal-1", status: "COMPLETED", images: [] },
		];
		const adapter = new FalProviderAdapter({
			apiKey: "fal-secret",
			fetch: (async (url, init) => {
				captured.push({
					url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
					init,
				});
				return response(bodies.shift());
			}) as typeof fetch,
		});

		const submission = await adapter.submit({
			attemptId: "attempt-1",
			providerModelId: "fal-ai/model",
			input: { kind: "text-to-image", prompt: "x" },
		});
		await adapter.retrieve({
			providerTaskId: "fal-1",
			resultUrl: submission.reconciliation.resultUrl,
		});

		expect(captured.map(({ url }) => url)).toEqual([
			"https://queue.fal.run/fal-ai/model",
			"https://queue.fal.run/fal-ai/model/requests/fal-1",
		]);
		for (const { init } of captured) {
			expect(init?.redirect).toBe("error");
			expect(new Headers(init?.headers).get("authorization")).toBe("Key fal-secret");
		}
	});

	it.each([
		"http://queue.fal.run/requests/fal-1",
		"https://attacker.example/requests/fal-1",
		"https://queue.fal.run.attacker.example/requests/fal-1",
		"https://queue.fal.run:443/requests/fal-1",
		"https://user:password@queue.fal.run/requests/fal-1",
		"https://queue.fal.run./requests/fal-1",
	])("rejects an unsafe submit response endpoint: %s", async (endpoint) => {
		let fetchCount = 0;
		const adapter = new FalProviderAdapter({
			apiKey: "fal-secret",
			fetch: (async () => {
				fetchCount += 1;
				return response({
					request_id: "fal-1",
					status: "IN_QUEUE",
					status_url: "https://queue.fal.run/requests/fal-1/status",
					response_url: endpoint,
				});
			}) as typeof fetch,
		});

		await expect(
			adapter.submit({
				attemptId: "attempt-1",
				providerModelId: "fal-ai/model",
				input: { kind: "text-to-image", prompt: "x" },
			}),
		).rejects.toMatchObject({
			code: "MALFORMED_PROVIDER_RESPONSE",
			retryable: false,
		});
		expect(fetchCount).toBe(1);
	});

	it.each([
		"http://queue.fal.run/requests/fal-1",
		"https://attacker.example/requests/fal-1",
		"https://queue.fal.run.attacker.example/requests/fal-1",
		"https://queue.fal.run:443/requests/fal-1",
		"https://user:password@queue.fal.run/requests/fal-1",
	])("rejects an unsafe stored endpoint before attaching the API key: %s", async (endpoint) => {
		let fetchCount = 0;
		const adapter = new FalProviderAdapter({
			apiKey: "fal-secret",
			fetch: (async () => {
				fetchCount += 1;
				return response({ request_id: "fal-1", status: "COMPLETED" });
			}) as typeof fetch,
		});

		await expect(
			adapter.retrieve({ providerTaskId: "fal-1", resultUrl: endpoint }),
		).rejects.toMatchObject({
			code: "MALFORMED_PROVIDER_RESPONSE",
			retryable: false,
		});
		expect(fetchCount).toBe(0);
	});
});
