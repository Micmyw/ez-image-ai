import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const fetch = vi.fn<typeof globalThis.fetch>();
	vi.stubGlobal("fetch", fetch);
	vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
	return { fetch };
});

vi.mock("node:https", () => ({
	request: vi.fn(() => {
		throw new Error("Node transport used unexpectedly");
	}),
}));

import { runWithCloudflareRemoteMedia } from "./cloudflare-remote-media";
import { copyRemoteStreamToMultipart, requestRemoteMediaStream } from "./stream-copy";

const image = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const options = {
	allowedHosts: ["cdn.provider.test"],
	resolve: async () => [{ address: "8.8.8.8", family: 4 as const }],
	maxRedirects: 2,
};

async function collect(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

beforeEach(() => {
	mocks.fetch.mockReset();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("Cloudflare public Internet media transport", () => {
	it("refuses to use the public-Internet adapter in a Node runtime", () => {
		vi.stubGlobal("navigator", { userAgent: "Node.js/24" });
		const operation = vi.fn();
		try {
			expect(() => runWithCloudflareRemoteMedia(operation)).toThrow(/Cloudflare Workers runtime/);
			expect(operation).not.toHaveBeenCalled();
		} finally {
			vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
		}
	});

	it("streams bytes through global fetch with manual redirects and no credential forwarding", async () => {
		mocks.fetch.mockResolvedValueOnce(new Response(image));
		const response = await runWithCloudflareRemoteMedia(() =>
			requestRemoteMediaStream("https://cdn.provider.test/image.png", options),
		);
		expect(await collect(response.stream)).toEqual(image);
		expect(mocks.fetch).toHaveBeenCalledWith("https://cdn.provider.test/image.png", {
			method: "GET",
			redirect: "manual",
			headers: { Accept: "image/*,video/*", "Accept-Encoding": "identity" },
			signal: expect.any(AbortSignal),
		});
	});

	it("rejects wildcard-only allowlists in the Worker transport", async () => {
		await expect(
			runWithCloudflareRemoteMedia(() =>
				requestRemoteMediaStream("https://cdn.provider.test/image.png", {
					...options,
					allowedHosts: ["*.provider.test"],
				}),
			),
		).rejects.toMatchObject({ code: "OUTPUT_REMOTE_URL_HOST_NOT_ALLOWED" });
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("cancels redirect bodies and checks DNS again before following the Location", async () => {
		const cancelled = vi.fn();
		const resolve = vi
			.fn()
			.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
			.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
		mocks.fetch.mockResolvedValueOnce(
			new Response(new ReadableStream({ cancel: cancelled }), {
				status: 302,
				headers: { Location: "/private" },
			}),
		);
		await expect(
			runWithCloudflareRemoteMedia(() =>
				requestRemoteMediaStream("https://cdn.provider.test/start", { ...options, resolve }),
			),
		).rejects.toMatchObject({ code: "OUTPUT_REMOTE_URL_PRIVATE_ADDRESS" });
		expect(resolve).toHaveBeenCalledTimes(2);
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
	});

	it("uses both DNS record families and rejects one private answer before the media request", async () => {
		mocks.fetch.mockImplementation(async (value) => {
			const url = new URL(value instanceof Request ? value.url : value);
			expect(url.origin).toBe("https://cloudflare-dns.com");
			const type = url.searchParams.get("type");
			return Response.json({
				Status: 0,
				Answer: [
					{
						type: type === "A" ? 1 : 28,
						data: type === "A" ? "8.8.8.8" : "::1",
					},
				],
			});
		});
		await expect(
			runWithCloudflareRemoteMedia(() =>
				requestRemoteMediaStream("https://cdn.provider.test/image.png", {
					...options,
					resolve: undefined,
				}),
			),
		).rejects.toMatchObject({ code: "OUTPUT_REMOTE_URL_PRIVATE_ADDRESS" });
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it("leaves resolver failures transient instead of accepting partial DNS answers", async () => {
		mocks.fetch.mockImplementation(async (value) => {
			const url = new URL(value instanceof Request ? value.url : value);
			return url.searchParams.get("type") === "A"
				? Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] })
				: Response.json({ Status: 2 });
		});
		await expect(
			runWithCloudflareRemoteMedia(() =>
				requestRemoteMediaStream("https://cdn.provider.test/image.png", {
					...options,
					resolve: undefined,
				}),
			),
		).rejects.toThrow(/DNS/i);
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it("aborts a request that never returns headers", async () => {
		vi.useFakeTimers();
		mocks.fetch.mockImplementation(
			(_value, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				}),
		);
		const result = runWithCloudflareRemoteMedia(() =>
			requestRemoteMediaStream("https://cdn.provider.test/image.png", {
				...options,
				connectTimeoutMs: 10,
			}),
		);
		const rejected = expect(result).rejects.toThrow(/connection timeout/i);
		await vi.advanceTimersByTimeAsync(11);
		await rejected;
	});

	it("cancels a body that never produces its first byte", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		mocks.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
		const response = await runWithCloudflareRemoteMedia(() =>
			requestRemoteMediaStream("https://cdn.provider.test/image.png", {
				...options,
				firstByteTimeoutMs: 10,
			}),
		);
		const rejected = expect(collect(response.stream)).rejects.toThrow(/first-byte timeout/i);
		await vi.advanceTimersByTimeAsync(11);
		await rejected;
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("keeps the total timeout active after bytes have started arriving", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		mocks.fetch.mockResolvedValueOnce(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(image);
					},
					cancel,
				}),
			),
		);
		const response = await runWithCloudflareRemoteMedia(() =>
			requestRemoteMediaStream("https://cdn.provider.test/image.png", {
				...options,
				totalTimeoutMs: 20,
			}),
		);
		const rejected = expect(collect(response.stream)).rejects.toThrow(/total timeout/i);
		await vi.advanceTimersByTimeAsync(21);
		await rejected;
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("aborts multipart writes and cancels the remote stream on the existing byte cap", async () => {
		const cancel = vi.fn();
		mocks.fetch.mockResolvedValueOnce(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(image);
					},
					cancel,
				}),
			),
		);
		const response = await runWithCloudflareRemoteMedia(() =>
			requestRemoteMediaStream("https://cdn.provider.test/image.png", options),
		);
		const abort = vi.fn();
		const uploadPart = vi.fn();
		await expect(
			copyRemoteStreamToMultipart(response.stream, {
				maxBytes: image.length - 1,
				partSize: 5,
				uploadPart,
				complete: vi.fn(),
				abort,
			}),
		).rejects.toMatchObject({ code: "OUTPUT_MEDIA_SIZE_EXCEEDED" });
		expect(abort).toHaveBeenCalledOnce();
		expect(uploadPart).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
	});

	it("does not leave a Worker transport active outside the request scope", async () => {
		mocks.fetch.mockResolvedValueOnce(new Response(image));
		const response = await runWithCloudflareRemoteMedia(() =>
			requestRemoteMediaStream("https://cdn.provider.test/image.png", options),
		);
		await collect(response.stream);
		await expect(
			requestRemoteMediaStream("https://cdn.provider.test/image.png", options),
		).rejects.toThrow("Node transport used unexpectedly");
		expect(mocks.fetch).toHaveBeenCalledOnce();
	});
});
