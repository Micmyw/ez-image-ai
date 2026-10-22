import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const fetch = vi.fn<typeof globalThis.fetch>();
	vi.stubGlobal("fetch", fetch);
	return { fetch };
});
import {
	canStreamImmutableGenerationImage,
	writeValidatedPrivateImageStream,
} from "./streaming-private-image";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const base = {
	url: "https://private.test/signed",
	contentType: "image/png" as const,
	timeoutMs: 2000,
};
beforeEach(() => {
	mocks.fetch.mockReset();
});

function receive(options: { beforeRead?: () => Promise<void> } = {}) {
	const chunks: Uint8Array[] = [];
	mocks.fetch.mockImplementation(async (_url, init) => {
		const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
		init!.signal!.addEventListener(
			"abort",
			() => {
				void reader.cancel(init!.signal!.reason).catch(() => undefined);
			},
			{ once: true },
		);
		await options.beforeRead?.();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(Uint8Array.from(value));
			}
			if (init!.signal!.aborted) throw init!.signal!.reason;
			return new Response(null, {
				status: 200,
				headers: { etag: "immutable", "x-amz-version-id": "v1" },
			});
		} finally {
			reader.releaseLock();
		}
	});
	return chunks;
}

describe("bounded private image stream", () => {
	it("hashes all bytes, preserves the exact object and uses one conditional request", async () => {
		const body = Buffer.concat([png, Buffer.alloc(256 * 1024, 19)]);
		const chunks = receive();
		const source = Readable.from(
			(function* () {
				for (let i = 0; i < body.length; i += 16384) yield body.subarray(i, i + 16384);
			})(),
		);
		await expect(
			writeValidatedPrivateImageStream({ ...base, source, contentLength: body.length }),
		).resolves.toEqual({
			bytes: body.length,
			sha256: createHash("sha256").update(body).digest("hex"),
			etag: "immutable",
			versionId: "v1",
		});
		expect(Buffer.concat(chunks)).toEqual(body);
		expect(mocks.fetch).toHaveBeenCalledOnce();
		expect(mocks.fetch.mock.calls[0]![1]).toMatchObject({
			method: "PUT",
			redirect: "manual",
			headers: { "If-None-Match": "*", "Content-Length": String(body.length) },
		});
		expect(source.destroyed).toBe(true);
	});

	it("does not pull a whole image while the storage consumer is blocked", async () => {
		let release!: () => void;
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		receive({ beforeRead: () => hold });
		let generated = 0;
		const source = Readable.from(
			(function* () {
				for (let i = 0; i < 160; i++) {
					const chunk = Buffer.alloc(65536);
					if (!i) png.copy(chunk);
					generated += chunk.length;
					yield chunk;
				}
			})(),
			{ objectMode: false, highWaterMark: 65536 },
		);
		const writing = writeValidatedPrivateImageStream({
			...base,
			source,
			contentLength: 10 * 1024 * 1024,
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(generated).toBeLessThanOrEqual(3 * 65536);
		release();
		await writing;
	});

	it.each(["oversize", "truncated", "invalid-signature"] as const)(
		"never sends the final byte for %s media",
		async (mode) => {
			const chunks = receive();
			const body = Buffer.concat([png, Buffer.alloc(32)]);
			const source =
				mode === "oversize"
					? Readable.from([body, Buffer.from([1])])
					: Readable.from([mode === "invalid-signature" ? Buffer.alloc(body.length) : body]);
			const length = mode === "truncated" ? body.length + 1 : body.length;
			await expect(
				writeValidatedPrivateImageStream({ ...base, source, contentLength: length }),
			).rejects.toMatchObject({
				code:
					mode === "invalid-signature"
						? "OUTPUT_MEDIA_TYPE_UNSUPPORTED"
						: "OUTPUT_MEDIA_SIZE_EXCEEDED",
			});
			expect(Buffer.concat(chunks).length).toBeLessThan(length);
			expect(source.destroyed).toBe(true);
		},
	);

	it("preserves conditional conflict and destroys an upstream stalled after the prefix", async () => {
		mocks.fetch.mockResolvedValue(new Response(null, { status: 412 }));
		let sent = false;
		const source = new Readable({
			read() {
				if (!sent) {
					sent = true;
					this.push(png);
				}
			},
		});
		await expect(
			writeValidatedPrivateImageStream({ ...base, source, contentLength: 65536 }),
		).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
		expect(source.destroyed).toBe(true);
	});

	it("times out and cancels a source stalled before its final byte", async () => {
		receive();
		let sent = false;
		const source = new Readable({
			read() {
				if (!sent) {
					sent = true;
					this.push(png);
				}
			},
		});
		await expect(
			writeValidatedPrivateImageStream({ ...base, source, contentLength: 65536, timeoutMs: 20 }),
		).rejects.toThrow("Private object stream timeout");
		expect(source.destroyed).toBe(true);
	});

	it("preserves a source failure and cancels its unfinished private write", async () => {
		const chunks = receive();
		const source = Readable.from(
			(async function* () {
				yield png;
				throw new Error("SUPPLIER_STREAM_FAILED");
			})(),
		);
		await expect(
			writeValidatedPrivateImageStream({ ...base, source, contentLength: 65536 }),
		).rejects.toThrow("SUPPLIER_STREAM_FAILED");
		expect(Buffer.concat(chunks).length).toBeLessThan(65536);
		expect(source.destroyed).toBe(true);
	});

	it("cancels a stalled upstream after a storage connection failure", async () => {
		mocks.fetch.mockRejectedValue(new Error("STORAGE_CONNECTION_FAILED"));
		const source = new Readable({ read() {} });
		await expect(
			writeValidatedPrivateImageStream({ ...base, source, contentLength: 65536 }),
		).rejects.toThrow("STORAGE_CONNECTION_FAILED");
		expect(source.destroyed).toBe(true);
	});

	it.each([undefined, "", "1e3", " 100", "0", "26214401", "-1"])(
		"rejects unsupported content length %s before allocation",
		(contentLength) => {
			expect(canStreamImmutableGenerationImage({ contentType: "image/png", contentLength })).toBe(
				false,
			);
		},
	);
	it("only admits supported images with positive bounded lengths", () => {
		expect(
			canStreamImmutableGenerationImage({ contentType: "image/png", contentLength: "26214400" }),
		).toBe(true);
		expect(
			canStreamImmutableGenerationImage({ contentType: "video/mp4", contentLength: 100 }),
		).toBe(false);
	});
});
