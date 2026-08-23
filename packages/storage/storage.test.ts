import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
	decodeInlineBase64Image,
	detectMediaType,
	validateMediaUpload,
} from "./lib/media-signatures";
import {
	createAssetObjectKey,
	createFinalAssetObjectKey,
	createStagingObjectKey,
} from "./lib/object-key";
import { assertAllowedRemoteUrl } from "./lib/remote-url-policy";
import {
	copyRemoteRequestToMultipart,
	copyRemoteStreamToMultipart,
	requestRemoteMediaStream,
} from "./lib/stream-copy";

const FIXTURES = {
	jpeg: Buffer.from("ffd8ffe000104a464946", "hex"),
	png: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
	webp: Buffer.from("52494646000000005745425056503820", "hex"),
	mp4: Buffer.from("00000018667479706d70343200000000", "hex"),
	webm: Buffer.from("1a45dfa39f4286810142f78101", "hex"),
	mov: Buffer.from("00000014667479707174202000000000", "hex"),
};

describe("private media storage policy", () => {
	it.each([
		[FIXTURES.jpeg, "image/jpeg"],
		[FIXTURES.png, "image/png"],
		[FIXTURES.webp, "image/webp"],
		[FIXTURES.mp4, "video/mp4"],
		[FIXTURES.webm, "video/webm"],
		[FIXTURES.mov, "video/quicktime"],
	] as const)("trusts the %s magic bytes over metadata", (bytes, expected) => {
		expect(detectMediaType(bytes)).toBe(expected);
	});

	it("rejects declared media when its magic bytes disagree", () => {
		expect(() => validateMediaUpload("image/png", FIXTURES.jpeg, 100)).toThrow(/signature/i);
	});

	it.each([
		["image/png", 25 * 1024 * 1024 + 1],
		["video/mp4", 500 * 1024 * 1024 + 1],
	] as const)("enforces the byte cap for %s", (mimeType, bytes) => {
		expect(() => validateMediaUpload(mimeType, FIXTURES.png, bytes)).toThrow(/limit/i);
	});

	it("isolates normalized object keys below the owning user and asset", () => {
		expect(createAssetObjectKey("user_1", "asset_2", "video/mp4", "thumbnail")).toBe(
			"users/user_1/assets/asset_2/thumbnail.mp4",
		);
		expect(() => createAssetObjectKey("../victim", "asset_2", "image/png")).toThrow(/identifier/i);
	});

	it("separates client-writable staging keys from immutable final asset keys", () => {
		const finalKey = createFinalAssetObjectKey("user_1", "asset_2", "version_3", "image/png");
		const stagingKey = createStagingObjectKey("user_1", "session_4", "nonce_5", "image/png");

		expect(finalKey).toBe("users/user_1/assets/asset_2/versions/version_3/original.png");
		expect(stagingKey).toBe("users/user_1/staging/session_4/nonce_5.png");
		expect(stagingKey).not.toBe(finalKey);
	});

	it("accepts capped inline images but rejects inline video", () => {
		const inlinePng = `data:image/png;base64,${FIXTURES.png.toString("base64")}`;
		expect(decodeInlineBase64Image(inlinePng).contentType).toBe("image/png");
		expect(() => decodeInlineBase64Image("data:video/mp4;base64,AAAA")).toThrow(/image/i);
	});
});

describe("remote URL policy", () => {
	it("requires HTTPS before resolving a remote host", async () => {
		const resolve = vi.fn();
		await expect(
			assertAllowedRemoteUrl("http://127.0.0.1/private", {
				allowedHosts: ["127.0.0.1"],
				resolve,
			}),
		).rejects.toThrow(/https/i);
		expect(resolve).not.toHaveBeenCalled();
	});

	it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fc00::1", "ff02::1"])(
		"rejects unsafe resolved address %s",
		async (address) => {
			await expect(
				assertAllowedRemoteUrl("https://cdn.provider.test/output", {
					allowedHosts: ["cdn.provider.test"],
					resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
				}),
			).rejects.toThrow(/address/i);
		},
	);

	it("rejects a hostname if any A or AAAA record is unsafe", async () => {
		await expect(
			assertAllowedRemoteUrl("https://cdn.provider.test/output", {
				allowedHosts: ["cdn.provider.test"],
				resolve: async () => [
					{ address: "203.0.113.10", family: 4 },
					{ address: "127.0.0.1", family: 4 },
				],
			}),
		).rejects.toThrow(/address/i);
	});

	it("returns every validated address so the requester can pin its connection", async () => {
		await expect(
			assertAllowedRemoteUrl("https://cdn.provider.test/output", {
				allowedHosts: ["cdn.provider.test"],
				resolve: async () => [{ address: "8.8.8.8", family: 4 }],
			}),
		).resolves.toMatchObject({ addresses: [{ address: "8.8.8.8", family: 4 }] });
	});

	it("revalidates DNS and pins the connection after every redirect", async () => {
		const resolved: string[] = [];
		const connected: string[] = [];
		const response = await requestRemoteMediaStream("https://cdn.provider.test/start", {
			allowedHosts: ["cdn.provider.test", "files.provider.test"],
			resolve: async (hostname) => {
				resolved.push(hostname);
				return [{ address: hostname.startsWith("cdn") ? "8.8.8.8" : "1.1.1.1", family: 4 }];
			},
			request: async ({ url, lookup }) => {
				await new Promise<void>((resolve, reject) =>
					lookup(url.hostname, {}, (error, address) => {
						if (error) reject(error);
						else {
							connected.push(address as string);
							resolve();
						}
					}),
				);
				return url.pathname === "/start"
					? {
							status: 302,
							headers: { location: "https://files.provider.test/final" },
							stream: Readable.from([]),
						}
					: { status: 200, headers: {}, stream: Readable.from([FIXTURES.png]) };
			},
			maxRedirects: 2,
		});
		expect(resolved).toEqual(["cdn.provider.test", "files.provider.test"]);
		expect(connected).toEqual(["8.8.8.8", "1.1.1.1"]);
		expect(response.url.hostname).toBe("files.provider.test");
	});

	it("fails closed if a redirect DNS answer changes to a private address", async () => {
		let resolution = 0;
		await expect(
			requestRemoteMediaStream("https://cdn.provider.test/start", {
				allowedHosts: ["cdn.provider.test"],
				resolve: async () => [{ address: ++resolution === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }],
				request: async ({ url }) => ({
					status: 302,
					headers: { location: url.toString() },
					stream: Readable.from([]),
				}),
				maxRedirects: 2,
			}),
		).rejects.toThrow(/address/i);
	});
});

describe("streaming multipart copy", () => {
	it("streams bounded parts, hashes incrementally, and never buffers the whole object", async () => {
		const parts: number[] = [];
		const source = Readable.from([Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4)]);
		const result = await copyRemoteStreamToMultipart(source, {
			maxBytes: 12,
			partSize: 5,
			uploadPart: async ({ body }) => {
				parts.push(body.byteLength);
				return `etag-${parts.length}`;
			},
			complete: async () => undefined,
			abort: async () => undefined,
		});
		expect(parts).toEqual([5, 5, 2]);
		expect(result.bytes).toBe(12);
		expect(result.sha256).toHaveLength(64);
	});

	it("assembles many tiny chunks with concatenation proportional to uploaded parts", async () => {
		const sourceBytes = Buffer.from(Array.from({ length: 4_097 }, (_, index) => index % 251));
		const uploaded: Buffer[] = [];
		const originalConcat = (chunks: readonly Uint8Array[], totalLength?: number) =>
			Buffer.concat(chunks, totalLength);
		let concatCalls = 0;
		const concatSpy = vi.spyOn(Buffer, "concat").mockImplementation((chunks, totalLength) => {
			concatCalls += 1;
			const size = totalLength ?? chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
			const result = Buffer.allocUnsafe(size);
			let offset = 0;
			for (const chunk of chunks) {
				const copied = Math.min(chunk.byteLength, size - offset);
				if (copied <= 0) break;
				result.set(chunk.subarray(0, copied), offset);
				offset += copied;
			}
			return result;
		});
		let result: Awaited<ReturnType<typeof copyRemoteStreamToMultipart>>;
		try {
			result = await copyRemoteStreamToMultipart(
				Readable.from(Array.from(sourceBytes, (byte) => Buffer.from([byte]))),
				{
					maxBytes: sourceBytes.byteLength,
					partSize: 1_024,
					uploadPart: async ({ body }) => {
						uploaded.push(Buffer.from(body));
						return `etag-${uploaded.length}`;
					},
					complete: async () => undefined,
					abort: async () => undefined,
				},
			);
		} finally {
			concatSpy.mockRestore();
		}

		expect(uploaded.map((part) => part.byteLength)).toEqual([1_024, 1_024, 1_024, 1_024, 1]);
		expect(originalConcat(uploaded)).toEqual(sourceBytes);
		expect(result.sha256).toBe(createHash("sha256").update(sourceBytes).digest("hex"));
		expect(concatCalls).toBeLessThanOrEqual(uploaded.length + 2);
	});

	it("aborts multipart when the source exceeds the byte cap", async () => {
		const abort = vi.fn(async () => undefined);
		await expect(
			copyRemoteStreamToMultipart(Readable.from([Buffer.alloc(6)]), {
				maxBytes: 5,
				partSize: 5,
				uploadPart: async () => "etag",
				complete: async () => undefined,
				abort,
			}),
		).rejects.toThrow(/limit/i);
		expect(abort).toHaveBeenCalledOnce();
	});

	it("aborts multipart after an upload failure", async () => {
		const abort = vi.fn(async () => undefined);
		await expect(
			copyRemoteStreamToMultipart(Readable.from([Buffer.alloc(5)]), {
				maxBytes: 5,
				partSize: 5,
				uploadPart: async () => {
					throw new Error("S3 unavailable");
				},
				complete: async () => undefined,
				abort,
			}),
		).rejects.toThrow(/unavailable/i);
		expect(abort).toHaveBeenCalledOnce();
	});

	it("checks magic bytes before uploading the first part", async () => {
		const uploadPart = vi.fn(async () => "etag");
		const abort = vi.fn(async () => undefined);
		await expect(
			copyRemoteStreamToMultipart(Readable.from([Buffer.alloc(5)]), {
				maxBytes: 5,
				partSize: 5,
				validateHeader: () => {
					throw new Error("Unsupported media signature");
				},
				uploadPart,
				complete: async () => undefined,
				abort,
			}),
		).rejects.toThrow(/signature/i);
		expect(uploadPart).not.toHaveBeenCalled();
		expect(abort).toHaveBeenCalledOnce();
	});

	it("aborts multipart when opening the validated remote stream fails", async () => {
		const abort = vi.fn(async () => undefined);
		await expect(
			copyRemoteRequestToMultipart(
				async () => {
					throw new Error("connection failed");
				},
				{
					maxBytes: 5,
					partSize: 5,
					uploadPart: async () => "etag",
					complete: async () => undefined,
					abort,
				},
			),
		).rejects.toThrow(/connection/i);
		expect(abort).toHaveBeenCalledOnce();
	});
});
