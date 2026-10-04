import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mp4Fixture } from "../../../storage/test-support/video-fixture";

const backend = vi.hoisted(() => ({
	parts: [] as Uint8Array[],
	object: null as Uint8Array | null,
	aborted: 0,
	completed: 0,
}));
vi.mock("@repo/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/storage")>()),
	abortIncompleteMultipartUploads: vi.fn(async () => 0),
	createMultipartUpload: vi.fn(async () => ({ uploadId: "multipart-1" })),
	uploadMultipartPart: vi.fn(async ({ body }: { body: Uint8Array }) => {
		backend.parts.push(body);
		return "part-etag";
	}),
	abortMultipartUpload: vi.fn(async () => {
		backend.aborted += 1;
	}),
	completeMultipartUpload: vi.fn(async ({ ifNoneMatch }: { ifNoneMatch: string }) => {
		expect(ifNoneMatch).toBe("*");
		backend.completed += 1;
		const size = backend.parts.reduce((sum, part) => sum + part.length, 0);
		backend.object = new Uint8Array(size);
		let at = 0;
		for (const part of backend.parts) {
			backend.object.set(part, at);
			at += part.length;
		}
	}),
	headObject: vi.fn(async () => {
		if (!backend.object) throw Object.assign(new Error("missing"), { name: "NotFound" });
		return {
			contentLength: backend.object.length,
			contentType: "video/mp4",
			etag: "sealed-etag",
			metadata: {},
		};
	}),
	readPrivateMediaStream: vi.fn(async ({ ifMatch }: { ifMatch: string }) => {
		expect(ifMatch).toBe("sealed-etag");
		const value = backend.object!;
		return {
			body: new ReadableStream({
				start(controller) {
					for (let i = 0; i < value.length; i += 65536)
						controller.enqueue(value.subarray(i, i + 65536));
					controller.close();
				},
			}),
		};
	}),
}));
import { inspectVideoObject, transferVideoOutput } from "./output-storage";
const options = (stream: Readable) => ({
	allowedHosts: ["cdn.video.test"],
	maxRedirects: 2,
	resolve: async () => [{ address: "8.8.8.8", family: 4 as const }],
	request: async () => ({ status: 200, headers: {}, stream }),
});

describe("video output bounded streaming", () => {
	beforeEach(() => {
		backend.parts = [];
		backend.object = null;
		backend.aborted = 0;
		backend.completed = 0;
	});
	it("uses bounded multipart and verifies a complete stored object after DB failure", async () => {
		const bytes = mp4Fixture({ mediaBytes: 6 * 1024 * 1024, moovLast: true });
		const source = Readable.from(
			(function* () {
				for (let i = 0; i < bytes.length; i += 65536) yield bytes.subarray(i, i + 65536);
			})(),
		);
		const stored = await transferVideoOutput({
			key: "users/u/video/asset.mp4",
			url: "https://cdn.video.test/file",
			maxBytes: 100 * 1024 * 1024,
			requestOptions: options(source),
		});
		expect(backend.parts).toHaveLength(2);
		expect(Math.max(...backend.parts.map((part) => part.length))).toBe(5 * 1024 * 1024);
		const recovered = await inspectVideoObject("users/u/video/asset.mp4");
		expect(recovered).toEqual(stored);
		expect(backend.completed).toBe(1);
	});
	it("aborts broken streams without completing a private object", async () => {
		const stream = Readable.from(
			(async function* () {
				yield mp4Fixture().subarray(0, 20);
				throw new Error("injected disconnect");
			})(),
		);
		await expect(
			transferVideoOutput({
				key: "users/u/a.mp4",
				url: "https://cdn.video.test/file",
				maxBytes: 1000,
				requestOptions: options(stream),
			}),
		).rejects.toThrow("injected disconnect");
		expect(backend.aborted).toBe(1);
		expect(backend.completed).toBe(0);
	});
	it.each([10, 30])(
		"verifies %i-second native AAC against the immutable request and recovers the stored bytes",
		async (durationSeconds) => {
			const constraints = {
				productKey: "video-kling-3",
				durationSeconds,
				sound: true,
				resolution: "720p",
				aspectRatio: "16:9",
			};
			const stored = await transferVideoOutput({
				key: "users/u/a.mp4",
				url: "https://cdn.video.test/file",
				maxBytes: 10000,
				constraints,
				requestOptions: options(
					Readable.from([mp4Fixture({ durationMillis: durationSeconds * 1000, audio: true })]),
				),
			});
			expect(stored).toMatchObject({
				durationMillis: durationSeconds * 1000,
				audioTracks: 1,
				audioTrackIds: [2],
			});
			expect(await inspectVideoObject("users/u/a.mp4", stored, constraints)).toEqual(stored);
		},
	);
	it.each([
		{ durationMillis: 5000, width: 1280, height: 720, code: "VIDEO_DURATION_MISMATCH" },
		{ durationMillis: 10000, width: 1920, height: 1080, code: "VIDEO_RESOLUTION_MISMATCH" },
	])(
		"rejects actual output specification mismatch before completing the object: $code",
		async ({ code, ...fixture }) => {
			await expect(
				transferVideoOutput({
					key: "users/u/a.mp4",
					url: "https://cdn.video.test/file",
					maxBytes: 10000,
					constraints: {
						productKey: "video-kling-3",
						durationSeconds: 10,
						sound: true,
						resolution: "720p",
						aspectRatio: "16:9",
					},
					requestOptions: options(Readable.from([mp4Fixture(fixture)])),
				}),
			).rejects.toThrow(code);
			expect(backend.completed).toBe(0);
			expect(backend.aborted).toBe(1);
		},
	);
	it.each([{ audio: true }, { mediaBytes: 1000 }])(
		"rejects audio or byte-limit violations before completing",
		async (fixture) => {
			await expect(
				transferVideoOutput({
					key: "users/u/a.mp4",
					url: "https://cdn.video.test/file",
					maxBytes: fixture.audio ? 10000 : 100,
					requestOptions: options(Readable.from([mp4Fixture(fixture)])),
				}),
			).rejects.toThrow();
			expect(backend.completed).toBe(0);
			expect(backend.aborted).toBe(1);
		},
	);
	it("rejects forbidden host and an allowed-host redirect resolving to a private address", async () => {
		await expect(
			transferVideoOutput({
				key: "users/u/a.mp4",
				url: "https://evil.test/file",
				maxBytes: 1000,
				requestOptions: options(Readable.from([])),
			}),
		).rejects.toThrow();
		await expect(
			transferVideoOutput({
				key: "users/u/a.mp4",
				url: "https://cdn.video.test/file",
				maxBytes: 1000,
				requestOptions: {
					...options(Readable.from([])),
					resolve: async () => [{ address: "127.0.0.1", family: 4 }],
				},
			}),
		).rejects.toThrow();
		expect(backend.completed).toBe(0);
	});
	it("rejects an audible MP4 beyond the ASR upload bound before sealing it", async () => {
		await expect(
			transferVideoOutput({
				key: "users/u/a.mp4",
				url: "https://cdn.video.test/file",
				maxBytes: 30_000_000,
				constraints: {
					durationSeconds: 5,
					sound: true,
					resolution: "default",
					aspectRatio: "source",
				},
				requestOptions: options(
					Readable.from([mp4Fixture({ audio: true, mediaBytes: 25_000_000 })]),
				),
			}),
		).rejects.toThrow("VIDEO_AUDIO_MEDIA_TOO_LARGE");
		expect(backend.completed).toBe(0);
		expect(backend.aborted).toBe(1);
	});
	it.each(["transfer", "recovery"] as const)(
		"allows a valid 30MB native-audio MP4 during %s when its frozen policy does not request speech review",
		async (path) => {
			const bytes = mp4Fixture({ audio: true, mediaBytes: 30_000_000 });
			const constraints = {
				productKey: "video-kling-3",
				durationSeconds: 5,
				sound: true,
				resolution: "720p",
				aspectRatio: "16:9",
				audioSafetyPolicy: { schemaVersion: 1 as const, mode: "not_requested" as const },
			};
			let stored;
			if (path === "transfer") {
				stored = await transferVideoOutput({
					key: "users/u/native.mp4",
					url: "https://cdn.video.test/file",
					maxBytes: 100 * 1024 * 1024,
					constraints,
					requestOptions: options(Readable.from([bytes])),
				});
				expect(backend.completed).toBe(1);
			} else {
				backend.object = bytes;
				stored = await inspectVideoObject(
					"users/u/native.mp4",
					{
						checksum: createHash("sha256").update(bytes).digest("hex"),
						etag: "sealed-etag",
						bytes: bytes.length,
					},
					constraints,
				);
				expect(backend.completed).toBe(0);
				expect(backend.parts).toHaveLength(0);
			}
			expect(stored).toMatchObject({
				bytes: bytes.length,
				audioTracks: 1,
				audioTrackIds: [2],
				durationMillis: 5000,
				width: 1280,
				height: 720,
			});
			expect(backend.aborted).toBe(0);
		},
	);
	it.each(["required", "missing"] as const)(
		"keeps the 25MB speech-review bound for %s policy on transfer and existing-object recovery",
		async (mode) => {
			const bytes = mp4Fixture({ audio: true, mediaBytes: 30_000_000 });
			const constraints = {
				productKey: "video-kling-3",
				durationSeconds: 5,
				sound: true,
				resolution: "720p",
				aspectRatio: "16:9",
				...(mode === "required"
					? { audioSafetyPolicy: { schemaVersion: 1 as const, mode: "required" as const } }
					: {}),
			};
			await expect(
				transferVideoOutput({
					key: "users/u/historical.mp4",
					url: "https://cdn.video.test/file",
					maxBytes: 100 * 1024 * 1024,
					constraints,
					requestOptions: options(Readable.from([bytes])),
				}),
			).rejects.toThrow("VIDEO_AUDIO_MEDIA_TOO_LARGE");
			expect(backend.completed).toBe(0);
			expect(backend.aborted).toBe(1);
			backend.object = bytes;
			await expect(
				inspectVideoObject("users/u/historical.mp4", undefined, constraints),
			).rejects.toThrow("VIDEO_AUDIO_MEDIA_TOO_LARGE");
		},
	);
	it("still rejects native audio when the immutable sound option is false under not-requested policy", async () => {
		const constraints = {
			productKey: "video-kling-3",
			durationSeconds: 5,
			sound: false,
			resolution: "720p",
			aspectRatio: "16:9",
			audioSafetyPolicy: { schemaVersion: 1 as const, mode: "not_requested" as const },
		};
		await expect(
			transferVideoOutput({
				key: "users/u/silent.mp4",
				url: "https://cdn.video.test/file",
				maxBytes: 100 * 1024 * 1024,
				constraints,
				requestOptions: options(
					Readable.from([mp4Fixture({ audio: true, mediaBytes: 30_000_000 })]),
				),
			}),
		).rejects.toThrow("VIDEO_AUDIO_TRACK_NOT_ALLOWED");
		expect(backend.completed).toBe(0);
		expect(backend.aborted).toBe(1);
	});
	it("rejects mutable storage identity even when headers match", async () => {
		backend.object = mp4Fixture();
		await expect(
			inspectVideoObject("users/u/a.mp4", {
				bytes: backend.object.length,
				etag: "sealed-etag",
				checksum: "0".repeat(64),
			}),
		).rejects.toThrow("VIDEO_STORED_IDENTITY_CHANGED");
	});
});
