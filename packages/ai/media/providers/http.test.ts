import { describe, expect, it, vi } from "vitest";

import { fetchJson } from "./http";

const encoder = new TextEncoder();

describe("fetchJson response bounds", () => {
	it("rejects an oversized declared response before reading its body", async () => {
		let canceled = false;
		let requestSignal: AbortSignal | null | undefined;
		const body = streamingBody(['{"private":"must-not-leak"}'], () => {
			canceled = true;
		});
		const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
			requestSignal = init?.signal;
			return new Response(body, {
				status: 200,
				headers: {
					"content-length": "1024",
					"content-type": "application/json",
				},
			});
		});

		await expect(
			fetchJson(
				"https://provider.example.test/result",
				{},
				{
					fetch: fetcher as typeof fetch,
					maxResponseBytes: 32,
				},
			),
		).rejects.toMatchObject({
			code: "MALFORMED_PROVIDER_RESPONSE",
			message: "Provider response exceeded the configured byte limit",
			retryable: false,
		});
		expect(canceled).toBe(true);
		expect(requestSignal?.aborted).toBe(true);
	});

	it("cancels a streamed response as soon as its accumulated bytes exceed the limit", async () => {
		let canceled = false;
		let requestSignal: AbortSignal | null | undefined;
		const body = streamingBody(['{"private":"', "must-not-leak", '"}'], () => {
			canceled = true;
		});
		const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
			requestSignal = init?.signal;
			return new Response(body, {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		await expect(
			fetchJson(
				"https://provider.example.test/result",
				{},
				{
					fetch: fetcher as typeof fetch,
					maxResponseBytes: encoder.encode('{"private":"x').byteLength,
				},
			),
		).rejects.toMatchObject({
			code: "MALFORMED_PROVIDER_RESPONSE",
			message: "Provider response exceeded the configured byte limit",
			retryable: false,
		});
		expect(canceled).toBe(true);
		expect(requestSignal?.aborted).toBe(true);
	});
});

function streamingBody(
	chunks: readonly string[],
	onCancel: () => void,
): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[index];
			if (chunk === undefined) {
				controller.close();
				return;
			}
			index += 1;
			controller.enqueue(encoder.encode(chunk));
		},
		cancel() {
			onCancel();
		},
	});
}
