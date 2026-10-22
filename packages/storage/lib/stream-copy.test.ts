import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { copyRemoteStreamToMultipart } from "./stream-copy";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("multipart download/upload pipeline", () => {
	it("assembles the next part during one upload and applies bounded backpressure", async () => {
		const partSize = 8192;
		const chunks = Array.from({ length: 10 }, (_, index) => Buffer.alloc(partSize, index));
		const first = deferred<string>();
		const started = deferred<void>();
		const assembledNext = deferred<void>();
		let pulled = 0;
		let active = 0;
		let maximumActive = 0;
		const uploaded: Buffer[] = [];
		const source = Readable.from(
			(function* () {
				for (const chunk of chunks) {
					pulled += 1;
					if (pulled === 3) assembledNext.resolve();
					yield chunk;
				}
			})(),
			{ highWaterMark: 1 },
		);
		const complete = vi.fn(async () => undefined);
		const abort = vi.fn(async () => undefined);
		const copying = copyRemoteStreamToMultipart(source, {
			partSize,
			maxBytes: chunks.length * partSize,
			uploadPart: async ({ body, partNumber }) => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				if (partNumber === 1) started.resolve();
				const etag = partNumber === 1 ? await first.promise : `etag-${partNumber}`;
				uploaded.push(Buffer.from(body));
				active -= 1;
				return etag;
			},
			complete,
			abort,
		});
		await started.promise;
		await assembledNext.promise;
		await setImmediate();
		expect(pulled).toBe(3); // Upload + assembly + the transport's one prefetched chunk.
		expect(active).toBe(1);
		expect(complete).not.toHaveBeenCalled();
		first.resolve("etag-1");
		const result = await copying;
		const expected = Buffer.concat(chunks);
		expect(Buffer.concat(uploaded)).toEqual(expected);
		expect(result).toEqual({
			bytes: expected.length,
			sha256: createHash("sha256").update(expected).digest("hex"),
			header: expected.subarray(0, 64),
		});
		expect(maximumActive).toBe(1);
		expect(complete).toHaveBeenCalledWith(
			chunks.map((_, index) => ({ partNumber: index + 1, etag: `etag-${index + 1}` })),
		);
		expect(abort).not.toHaveBeenCalled();
	});

	it("an upload failure wakes a stalled supplier and preserves the upload error", async () => {
		const part = deferred<string>();
		const started = deferred<void>();
		const source = new Readable({ read() {} });
		source.push(Buffer.alloc(16));
		const failure = new Error("part upload disconnected");
		const abort = vi.fn(async () => undefined);
		const complete = vi.fn(async () => undefined);
		const copying = copyRemoteStreamToMultipart(source, {
			partSize: 16,
			maxBytes: 1024,
			uploadPart: () => {
				started.resolve();
				return part.promise;
			},
			abort,
			complete,
		});
		const rejected = expect(copying).rejects.toBe(failure);
		await started.promise;
		part.reject(failure);
		await rejected;
		expect(source.destroyed).toBe(true);
		expect(abort).toHaveBeenCalledOnce();
		expect(complete).not.toHaveBeenCalled();
	});

	it("cancels an active upload before multipart cleanup when the supplier fails", async () => {
		const started = deferred<void>();
		const failure = new Error("supplier disconnected");
		const events: string[] = [];
		const source = Readable.from(
			(async function* () {
				yield Buffer.alloc(16);
				await started.promise;
				throw failure;
			})(),
		);
		const complete = vi.fn(async () => undefined);
		await expect(
			copyRemoteStreamToMultipart(source, {
				partSize: 16,
				maxBytes: 1024,
				uploadPart: ({ signal }) =>
					new Promise<string>((_resolve, reject) => {
						signal!.addEventListener("abort", () => {
							events.push("upload-cancelled");
							reject(new Error("upload aborted"));
						});
						started.resolve();
					}),
				complete,
				abort: async () => {
					events.push("multipart-aborted");
				},
			}),
		).rejects.toBe(failure);
		expect(events).toEqual(["upload-cancelled", "multipart-aborted"]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("drains a legacy upload which ignores cancellation before aborting multipart", async () => {
		const part = deferred<string>();
		const started = deferred<void>();
		const failed = deferred<void>();
		const failure = new Error("supplier disconnected");
		const source = Readable.from(
			(async function* () {
				yield Buffer.alloc(16);
				await started.promise;
				failed.resolve();
				throw failure;
			})(),
		);
		const abort = vi.fn(async () => undefined);
		const complete = vi.fn(async () => undefined);
		const copying = copyRemoteStreamToMultipart(source, {
			partSize: 16,
			maxBytes: 1024,
			uploadPart: () => {
				started.resolve();
				return part.promise;
			},
			complete,
			abort,
		});
		const rejected = expect(copying).rejects.toBe(failure);
		await failed.promise;
		await setImmediate();
		expect(abort).not.toHaveBeenCalled();
		part.resolve("etag-1");
		await rejected;
		expect(abort).toHaveBeenCalledOnce();
		expect(complete).not.toHaveBeenCalled();
	});
});
