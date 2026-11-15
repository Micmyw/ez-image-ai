import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { moderationImageHeader } from "./moderation-image-header";

describe("moderation image header", () => {
	it("uses a split image header and preserves every source byte exactly once", async () => {
		const bytes = await sharp({
			create: { width: 512, height: 320, channels: 3, background: "red" },
		})
			.png()
			.toBuffer();
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < bytes.length; offset += 7)
					controller.enqueue(bytes.subarray(offset, offset + 7));
				controller.close();
			},
		});
		const prepared = await moderationImageHeader(source);
		expect(prepared.side).toBe(512);
		expect(Buffer.from(await new Response(prepared.source).arrayBuffer())).toEqual(bytes);
		expect(source.locked).toBe(false);
	});
	it("falls back after a bounded header while retaining the remaining body", async () => {
		const bytes = new Uint8Array(300_000).fill(1);
		const source = new Blob([bytes]).stream();
		const prepared = await moderationImageHeader(source);
		expect(prepared.side).toBe(1568);
		expect(new Uint8Array(await new Response(prepared.source).arrayBuffer())).toEqual(bytes);
	});
	it("cancels the original reader when preparation stops", async () => {
		const bytes = await sharp({
			create: { width: 512, height: 320, channels: 3, background: "red" },
		})
			.png()
			.toBuffer();
		const cancel = vi.fn();
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
			},
			cancel,
		});
		const prepared = await moderationImageHeader(source);
		await prepared.source.cancel("preparation failed");
		expect(cancel).toHaveBeenCalledOnce();
		expect(source.locked).toBe(false);
	});
});
