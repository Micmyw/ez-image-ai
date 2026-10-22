import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	process.env.S3_ENDPOINT = "https://storage.test";
	process.env.S3_ACCESS_KEY_ID = "fixture";
	process.env.S3_SECRET_ACCESS_KEY = "fixture";
	process.env.MEDIA_BUCKET_NAME = "private-test";
	const fetch = vi.fn<typeof globalThis.fetch>();
	vi.stubGlobal("fetch", fetch);
	return { send: vi.fn(), fetch };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({
	getSignedUrl: vi.fn(async () => "https://storage.test/signed"),
}));
vi.mock("@aws-sdk/client-s3", async (original) => ({
	...(await original<typeof import("@aws-sdk/client-s3")>()),
	S3Client: class {
		send = mocks.send;
	},
}));

import { openInspectedRemoteMedia } from "../../lib/stream-copy";
import { streamRemoteObjectToStorage, tryWriteImmutableGenerationImage } from "./index";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const sourceUrl = "https://cdn.provider.test/result.png";
const allowedHosts = ["cdn.provider.test"];
const location = { bucket: "media" as const, key: "users/owner/assets/output.png" };

async function openDownload(body: Buffer, contentLength: string | undefined = String(body.length)) {
	const chunks: Buffer[] = [];
	for (let offset = 0; offset < body.length; offset += 64 * 1024)
		chunks.push(body.subarray(offset, offset + 64 * 1024));
	const request = vi.fn(async () => ({
		status: 200,
		headers: { "content-length": contentLength },
		stream: Readable.from(chunks),
	}));
	const opened = await openInspectedRemoteMedia(sourceUrl, {
		allowedHosts,
		expectedKind: "image",
		maxRedirects: 0,
		resolve: async () => [{ address: "8.8.8.8", family: 4 }],
		request,
	});
	return { request, opened };
}

function storageFixture() {
	const written: Buffer[] = [];
	const parts: Buffer[] = [];
	mocks.fetch.mockImplementation(async (_url, options) => {
		written.push(Buffer.from(await new Response(options!.body).arrayBuffer()));
		return new Response(null, { status: 200, headers: { etag: "sealed" } });
	});
	mocks.send.mockImplementation(
		async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
			switch (command.constructor.name) {
				case "GetObjectCommand":
					throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
				case "PutObjectCommand":
					written.push(Buffer.from(command.input.Body as Buffer));
					return { ETag: "sealed" };
				case "CreateMultipartUploadCommand":
					return { UploadId: "multipart" };
				case "UploadPartCommand":
					parts.push(Buffer.from(command.input.Body as Buffer));
					return { ETag: `part-${parts.length}` };
				case "CompleteMultipartUploadCommand":
					return {};
				case "AbortMultipartUploadCommand":
					return {};
				default:
					throw new Error(`UNEXPECTED_COMMAND:${command.constructor.name}`);
			}
		},
	);
	return { written, parts };
}

beforeEach(() => {
	mocks.send.mockReset();
	mocks.fetch.mockReset();
});

describe("one supplier stream across direct and staged image storage", () => {
	it.each([undefined, true])(
		"writes the exact inspected response once with freshClaim=%s",
		async (freshClaim) => {
			const body = Buffer.concat([png, Buffer.alloc(4096, 0x51)]);
			const f = await openDownload(body);
			const storage = storageFixture();
			const reserve = vi.fn(async () => undefined);
			try {
				const result = await tryWriteImmutableGenerationImage({
					...location,
					contentType: "image/png",
					sourceUrl,
					allowedHosts,
					openedSource: f.opened,
					freshClaim,
					reserve,
				});
				expect(result).toMatchObject({
					bytes: body.length,
					sha256: createHash("sha256").update(body).digest("hex"),
				});
				expect(storage.written).toEqual([body]);
				expect(f.request).toHaveBeenCalledTimes(1);
				expect(reserve).toHaveBeenCalledWith(body.length);
				expect(mocks.send.mock.calls.map(([command]) => command.constructor.name)).toEqual(
					freshClaim ? [] : ["GetObjectCommand"],
				);
			} finally {
				f.opened.stream.destroy();
			}
		},
	);

	it.each([undefined, true])(
		"passes an untouched unknown-length response to staging with freshClaim=%s",
		async (freshClaim) => {
			const body = Buffer.concat([png, Buffer.alloc(4096, 0x51)]);
			const f = await openDownload(body, "");
			const storage = storageFixture();
			const reserve = vi.fn(async () => undefined);
			try {
				expect(
					await tryWriteImmutableGenerationImage({
						...location,
						contentType: "image/png",
						sourceUrl,
						allowedHosts,
						openedSource: f.opened,
						freshClaim,
						reserve,
					}),
				).toBeNull();
				expect(f.opened.stream.destroyed).toBe(false);
				expect(reserve).not.toHaveBeenCalled();
				const result = await streamRemoteObjectToStorage({
					...location,
					sourceUrl,
					allowedHosts,
					expectedContentType: "image/png",
					expectedMediaKind: "image",
					openedSource: f.opened,
				});
				expect(result).toEqual({
					bytes: body.length,
					sha256: createHash("sha256").update(body).digest("hex"),
				});
				const uploaded = Buffer.concat(storage.parts);
				expect(uploaded.length).toBe(body.length);
				expect(createHash("sha256").update(uploaded).digest("hex")).toBe(result.sha256);
				expect(storage.written).toHaveLength(0);
				expect(f.request).toHaveBeenCalledTimes(1);
			} finally {
				f.opened.stream.destroy();
			}
		},
	);

	it.each(["conflict", "unknown"])(
		"recovers a fresh streamed PUT %s from the full winner without reopening the supplier",
		async (failure) => {
			const source = Buffer.concat([png, Buffer.alloc(100, 0x51)]);
			const canonical = Buffer.concat([png, Buffer.alloc(1000, 0x62)]);
			const f = await openDownload(source);
			mocks.fetch.mockImplementation(async () => {
				if (failure === "conflict") return new Response(null, { status: 412 });
				throw new Error("PUT response lost");
			});
			mocks.send.mockResolvedValueOnce({
				Body: Readable.from([canonical.subarray(0, 64), canonical.subarray(64)]),
				ContentLength: canonical.length,
				ContentType: "image/png",
				ETag: "canonical",
				Metadata: { sha256: "f".repeat(64) },
			});
			const reserve = vi.fn(async (_bytes: number) => undefined);
			try {
				const result = await tryWriteImmutableGenerationImage({
					...location,
					contentType: "image/png",
					sourceUrl,
					allowedHosts,
					openedSource: f.opened,
					freshClaim: true,
					reserve,
				});
				expect(result).toMatchObject({
					bytes: canonical.length,
					sha256: createHash("sha256").update(canonical).digest("hex"),
				});
				expect(f.request).toHaveBeenCalledTimes(1);
				expect(mocks.fetch).toHaveBeenCalledTimes(1);
				expect(mocks.send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
					"GetObjectCommand",
				]);
				expect(reserve.mock.calls.map(([bytes]) => bytes)).toEqual([
					source.length,
					canonical.length,
				]);
			} finally {
				f.opened.stream.destroy();
			}
		},
	);

	it("keeps fresh-stream EOF validation failures fatal without claiming an existing object", async () => {
		const source = Buffer.concat([png, Buffer.alloc(100, 0x51)]);
		const f = await openDownload(source, String(source.length + 1));
		storageFixture();
		try {
			await expect(
				tryWriteImmutableGenerationImage({
					...location,
					contentType: "image/png",
					openedSource: f.opened,
					freshClaim: true,
					reserve: async () => undefined,
				}),
			).rejects.toMatchObject({ code: "OUTPUT_MEDIA_SIZE_EXCEEDED" });
			expect(mocks.send).not.toHaveBeenCalled();
			expect(mocks.fetch).toHaveBeenCalledTimes(1);
			expect(f.request).toHaveBeenCalledTimes(1);
		} finally {
			f.opened.stream.destroy();
		}
	});

	it("preserves final-object recovery without opening an expired supplier URL", async () => {
		mocks.send.mockResolvedValueOnce({
			Body: Readable.from([png]),
			ContentLength: png.length,
			ContentType: "image/png",
			ETag: "sealed",
		});
		const request = vi.fn(async () => {
			throw new Error("SUPPLIER_URL_EXPIRED");
		});
		const result = await tryWriteImmutableGenerationImage(
			{
				...location,
				contentType: "image/png",
				sourceUrl,
				allowedHosts,
				reserve: async () => undefined,
			},
			{ request },
		);
		expect(result?.etag).toBe("sealed");
		expect(request).not.toHaveBeenCalled();
	});

	it("aborts a staged transfer when the reused stream exceeds its byte cap", async () => {
		const body = Buffer.concat([png, Buffer.alloc(4096, 0x51)]);
		const f = await openDownload(body, "");
		storageFixture();
		try {
			await expect(
				streamRemoteObjectToStorage({
					...location,
					sourceUrl,
					allowedHosts,
					expectedContentType: "image/png",
					maxBytes: 32,
					openedSource: f.opened,
				}),
			).rejects.toMatchObject({ code: "OUTPUT_MEDIA_SIZE_EXCEEDED" });
			expect(mocks.send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
				"CreateMultipartUploadCommand",
				"AbortMultipartUploadCommand",
			]);
			expect(f.opened.stream.destroyed).toBe(true);
		} finally {
			f.opened.stream.destroy();
		}
	});
});
