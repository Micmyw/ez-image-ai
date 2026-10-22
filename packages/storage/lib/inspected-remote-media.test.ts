import { once } from "node:events";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { openInspectedRemoteMedia, type RemoteMediaRequestOptions } from "./stream-copy";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const policy = {
	allowedHosts: ["cdn.provider.test"],
	maxRedirects: 1,
	expectedKind: "image" as const,
	resolve: async () => [{ address: "8.8.8.8", family: 4 as const }],
};

function open(source: Readable, options: Partial<RemoteMediaRequestOptions> = {}) {
	const request = vi.fn(async () => ({ status: 200, headers: {}, stream: source }));
	return {
		request,
		result: openInspectedRemoteMedia("https://cdn.provider.test/output", {
			...policy,
			request,
			...options,
		}),
	};
}

async function collect(source: Readable) {
	const chunks: Buffer[] = [];
	for await (const chunk of source) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

function stalledSource() {
	let sent = false;
	const cancelled = vi.fn();
	const source = new Readable({
		read() {
			if (sent) return;
			sent = true;
			this.push(png);
		},
		destroy(error, callback) {
			cancelled();
			callback(error);
		},
	});
	return { source, cancelled };
}

describe("inspected supplier download reuse", () => {
	it.each([1, 3, 8, 64, 1024])("replays every byte with %s-byte supplier chunks", async (size) => {
		const body = Buffer.concat([png, Buffer.alloc(4096, 0x51)]);
		const chunks: Buffer[] = [];
		for (let offset = 0; offset < body.length; offset += size)
			chunks.push(body.subarray(offset, offset + size));
		const f = open(Readable.from(chunks));
		const opened = await f.result;
		expect(opened.contentType).toBe("image/png");
		expect(opened.url.toString()).toBe("https://cdn.provider.test/output");
		expect(await collect(opened.stream)).toEqual(body);
		expect(f.request).toHaveBeenCalledTimes(1);
	});

	it("preserves a supplier chunk larger than the detection prefix", async () => {
		const body = Buffer.concat([png, Buffer.alloc(256 * 1024, 0x51)]);
		const f = open(Readable.from([body]));
		expect(await collect((await f.result).stream)).toEqual(body);
		expect(f.request).toHaveBeenCalledTimes(1);
	});

	it("cancels upstream even when the inspected stream was never consumed", async () => {
		const f = stalledSource();
		const opened = await open(f.source).result;
		const closed = once(opened.stream, "close");
		opened.stream.destroy();
		await closed;
		expect(f.source.destroyed).toBe(true);
		expect(f.cancelled).toHaveBeenCalledOnce();
	});

	it("cancels a pending downstream read without waiting for more supplier bytes", async () => {
		const f = stalledSource();
		const opened = await open(f.source).result;
		const reader = opened.stream[Symbol.asyncIterator]();
		expect((await reader.next()).value).toEqual(png);
		const pending = reader.next();
		opened.stream.destroy(new Error("TRANSFER_CANCELLED"));
		await expect(pending).rejects.toThrow("TRANSFER_CANCELLED");
		expect(f.source.destroyed).toBe(true);
		expect(f.cancelled).toHaveBeenCalledOnce();
	});

	it("retains an upstream timeout during a database hold without an unhandled error", async () => {
		const f = stalledSource();
		const opened = await open(f.source).result;
		f.source.destroy(new Error("SUPPLIER_TOTAL_TIMEOUT"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		await expect(collect(opened.stream)).rejects.toThrow("SUPPLIER_TOTAL_TIMEOUT");
		expect(f.cancelled).toHaveBeenCalledOnce();
	});

	it("does not read beyond an unsupported bounded prefix", async () => {
		let requestedChunks = 0;
		const source = new Readable({
			highWaterMark: 1,
			read() {
				requestedChunks += 1;
				this.push(Buffer.alloc(64, 0x61));
			},
		});
		await expect(open(source).result).rejects.toMatchObject({
			code: "OUTPUT_MEDIA_TYPE_UNSUPPORTED",
		});
		expect(requestedChunks).toBeLessThanOrEqual(2); // One transport-buffered chunk may be prefetched.
		expect(source.destroyed).toBe(true);
	});

	it("rejects the wrong media kind and closes the original stream", async () => {
		const source = Readable.from([Buffer.from("00000018667479706d70343200000000", "hex")]);
		await expect(open(source).result).rejects.toMatchObject({ code: "OUTPUT_MEDIA_KIND_MISMATCH" });
		expect(source.destroyed).toBe(true);
	});

	it("keeps redirect policy checks before opening another supplier host", async () => {
		const redirected = Readable.from([png]);
		const request = vi.fn(async () => ({
			status: 302,
			headers: { location: "https://private.provider.test/image.png" },
			stream: redirected,
		}));
		await expect(
			openInspectedRemoteMedia("https://cdn.provider.test/output", {
				...policy,
				allowedHosts: ["cdn.provider.test", "private.provider.test"],
				resolve: async (hostname) => [
					{ address: hostname === "private.provider.test" ? "127.0.0.1" : "8.8.8.8", family: 4 },
				],
				request,
			}),
		).rejects.toMatchObject({ code: "OUTPUT_REMOTE_URL_PRIVATE_ADDRESS" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(redirected.destroyed).toBe(true);
	});
});
