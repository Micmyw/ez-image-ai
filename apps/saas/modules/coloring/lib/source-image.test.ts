import { describe, expect, it, vi } from "vitest";

import { readColoringSourceImage } from "./source-image";

describe("guest image import", () => {
	it("preserves authorized image bytes in a file for the normal uploader", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const fetcher = vi
			.fn()
			.mockResolvedValue(new Response(bytes, { headers: { "content-type": "image/webp" } }));
		const file = await readColoringSourceImage("https://private.test/approved", {
			fetcher,
			signal: new AbortController().signal,
		});
		expect(file.name).toBe("selected-image.webp");
		expect(file.type).toBe("image/webp");
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
		expect(fetcher).toHaveBeenCalledWith(
			"https://private.test/approved",
			expect.objectContaining({
				credentials: "omit",
				cache: "no-store",
				referrerPolicy: "no-referrer",
			}),
		);
	});
	it.each([
		{ body: "denied", type: "image/png", status: 403 },
		{ body: "<svg/>", type: "image/svg+xml", status: 200 },
		{ body: "", type: "image/png", status: 200 },
	])("rejects unavailable, unsupported or empty responses", async ({ body, type, status }) => {
		await expect(
			readColoringSourceImage("https://private.test/approved", {
				signal: new AbortController().signal,
				fetcher: vi
					.fn()
					.mockResolvedValue(new Response(body, { status, headers: { "content-type": type } })),
			}),
		).rejects.toThrow();
	});
	it("bounds streamed bytes even without a content length", async () => {
		const cancel = vi.fn();
		const response = new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new Uint8Array(1024 * 1024));
				},
				cancel,
			}),
			{ headers: { "content-type": "image/png" } },
		);
		await expect(
			readColoringSourceImage("https://private.test/approved", {
				signal: new AbortController().signal,
				fetcher: vi.fn().mockResolvedValue(response),
			}),
		).rejects.toThrow("COLORING_SOURCE_TOO_LARGE");
		expect(cancel).toHaveBeenCalledOnce();
	});
});
