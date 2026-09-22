import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { writeImmutableReference } from "./immutable-reference";

function target() {
	return {
		put: vi.fn(async () => undefined),
		createMultipart: vi.fn(async () => "upload-1"),
		uploadPart: vi.fn(async () => "etag"),
		complete: vi.fn(async () => undefined),
		abort: vi.fn(async () => undefined),
	};
}
function png(size: number) {
	const buffer = Buffer.alloc(size, 7);
	Buffer.from("89504e470d0a1a0a", "hex").copy(buffer);
	return buffer;
}
function stream(bytes: Buffer): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.subarray(offset, offset + 2048));
			offset += 2048;
		},
	});
}
describe("immutable temporary reference transfer", () => {
	it("writes a small image once with its actual checksum, without multipart or a readback", async () => {
		const bytes = png(30_802);
		const storage = target();
		const result = await writeImmutableReference(
			{ body: stream(bytes), contentLength: bytes.length, contentType: "image/png" },
			storage,
		);
		expect(result).toEqual({
			bytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		});
		expect(storage.put).toHaveBeenCalledExactlyOnceWith(bytes, result.sha256);
		expect(storage.createMultipart).not.toHaveBeenCalled();
	});
	it("writes an image of exactly ten MiB with one PUT", async () => {
		const bytes = png(10 * 1024 * 1024);
		const storage = target();
		const result = await writeImmutableReference(
			{ body: stream(bytes), contentLength: bytes.length, contentType: "image/png" },
			storage,
		);
		expect(storage.put).toHaveBeenCalledOnce();
		const [body, checksum] = storage.put.mock.calls[0] as unknown as [Buffer, string];
		expect(body.equals(bytes)).toBe(true);
		expect(checksum).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(result).toEqual({ bytes: bytes.length, sha256: checksum });
		expect(storage.createMultipart).not.toHaveBeenCalled();
	});
	it("streams a large image in parts no larger than five MiB", async () => {
		const bytes = png(12 * 1024 * 1024 + 2);
		const storage = target();
		await writeImmutableReference(
			{ body: stream(bytes), contentLength: bytes.length, contentType: "image/png" },
			storage,
		);
		expect(storage.put).not.toHaveBeenCalled();
		expect(storage.uploadPart).toHaveBeenCalledTimes(3);
		const bodies = storage.uploadPart.mock.calls.map(
			(call) => (call as unknown as [string, number, Buffer])[2],
		);
		expect(bodies.every((body) => body.length <= 5 * 1024 * 1024)).toBe(true);
		expect(Buffer.concat(bodies).equals(bytes)).toBe(true);
		expect(storage.complete).toHaveBeenCalledOnce();
	});
	it.each(["short", "long", "wrong-type"])(
		"rejects a %s body before committing an object",
		async (kind) => {
			const bytes = kind === "wrong-type" ? Buffer.alloc(128) : png(128);
			const storage = target();
			await expect(
				writeImmutableReference(
					{
						body: stream(bytes),
						contentLength: kind === "short" ? 129 : kind === "long" ? 127 : 128,
						contentType: "image/png",
					},
					storage,
				),
			).rejects.toThrow();
			expect(storage.put).not.toHaveBeenCalled();
			expect(storage.complete).not.toHaveBeenCalled();
		},
	);
	it("aborts incomplete multipart after a truncated large request", async () => {
		const bytes = png(12 * 1024 * 1024);
		const storage = target();
		await expect(
			writeImmutableReference(
				{ body: stream(bytes), contentLength: bytes.length + 1, contentType: "image/png" },
				storage,
			),
		).rejects.toThrow();
		expect(storage.abort).toHaveBeenCalledExactlyOnceWith("upload-1");
		expect(storage.complete).not.toHaveBeenCalled();
	});
});
