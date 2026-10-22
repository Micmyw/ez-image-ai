import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { createVideoOutputReport, videoOutputConstraints } from "@repo/config/video-output";
import {
	abortIncompleteMultipartUploads,
	headObject,
	readPrivateMediaStream,
	uploadMultipartPart,
} from "@repo/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mp4Fixture } from "../../../storage/test-support/video-fixture";

const backend = vi.hoisted(() => ({
	parts: [] as Uint8Array[],
	object: null as Uint8Array | null,
	aborted: 0,
	completed: 0,
	etag: "sealed-etag",
	readBytes: 0,
	headDelayMs: 0,
	fullDelayMs: 0,
	probeDelayMs: 0,
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
		if (backend.headDelayMs)
			await new Promise((resolve) => setTimeout(resolve, backend.headDelayMs));
		if (!backend.object) throw Object.assign(new Error("missing"), { name: "NotFound" });
		return {
			contentLength: backend.object.length,
			contentType: "video/mp4",
			etag: backend.etag,
			metadata: {},
		};
	}),
	readPrivateMediaStream: vi.fn(
		async ({ ifMatch, range }: { ifMatch: string; range?: { start: number; end: number } }) => {
			const delay = range ? backend.probeDelayMs : backend.fullDelayMs;
			if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
			if (ifMatch !== backend.etag)
				throw Object.assign(new Error("changed"), { name: "PreconditionFailed" });
			const value = range ? backend.object!.subarray(range.start, range.end + 1) : backend.object!;
			backend.readBytes += value.length;
			return {
				contentLength: value.length,
				contentType: "video/mp4",
				etag: backend.etag,
				body: new ReadableStream({
					start(controller) {
						for (let i = 0; i < value.length; i += 65536)
							controller.enqueue(value.subarray(i, i + 65536));
						controller.close();
					},
				}),
			};
		},
	),
}));
import {
	inspectPersistedVideoObject,
	inspectVideoObject,
	transferVideoOutput,
} from "./output-storage";
const options = (stream: Readable) => ({
	allowedHosts: ["cdn.video.test"],
	maxRedirects: 2,
	resolve: async () => [{ address: "8.8.8.8", family: 4 as const }],
	request: async () => ({ status: 200, headers: {}, stream }),
});

describe("video output bounded streaming", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		backend.parts = [];
		backend.object = null;
		backend.aborted = 0;
		backend.completed = 0;
		backend.etag = "sealed-etag";
		backend.readBytes = 0;
		backend.headDelayMs = 0;
		backend.fullDelayMs = 0;
		backend.probeDelayMs = 0;
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
		expect(abortIncompleteMultipartUploads).toHaveBeenCalledWith({
			bucket: "media",
			key: "users/u/video/asset.mp4",
		});
	});
	it("skips prior multipart recovery only for a fresh identity and still verifies the final HEAD", async () => {
		const bytes = mp4Fixture();
		const stored = await transferVideoOutput({
			key: "users/u/video/fresh.mp4",
			url: "https://cdn.video.test/file",
			maxBytes: 10000,
			freshTransfer: true,
			requestOptions: options(Readable.from([bytes])),
		});
		expect(abortIncompleteMultipartUploads).not.toHaveBeenCalled();
		expect(headObject).toHaveBeenCalledExactlyOnceWith({
			bucket: "media",
			key: "users/u/video/fresh.mp4",
		});
		expect(stored.checksum).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(Buffer.from(backend.object!)).toEqual(Buffer.from(bytes));
		expect(backend.completed).toBe(1);
	});
	it("cancels a stalled supplier immediately when a pipelined upload fails", async () => {
		const bytes = mp4Fixture({ mediaBytes: 6 * 1024 * 1024, moovLast: true });
		const source = new Readable({ read() {} });
		source.push(bytes.subarray(0, 5 * 1024 * 1024));
		const failure = new Error("storage disconnected");
		vi.mocked(uploadMultipartPart).mockRejectedValueOnce(failure);
		await expect(
			transferVideoOutput({
				key: "users/u/video/fresh.mp4",
				url: "https://cdn.video.test/file",
				maxBytes: 100 * 1024 * 1024,
				freshTransfer: true,
				requestOptions: options(source),
			}),
		).rejects.toBe(failure);
		expect(source.destroyed).toBe(true);
		expect(backend.aborted).toBe(1);
		expect(backend.completed).toBe(0);
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
		"preserves usable output and its actual metadata despite quality deviation: $code",
		async ({ code: _code, ...fixture }) => {
			const constraints = {
				productKey: "video-kling-3",
				durationSeconds: 10,
				sound: true,
				resolution: "720p",
				aspectRatio: "16:9",
			};
			const bytes = mp4Fixture(fixture);
			const stored = await transferVideoOutput({
				key: "users/u/a.mp4",
				url: "https://cdn.video.test/file",
				maxBytes: 10000,
				constraints,
				requestOptions: options(Readable.from([bytes])),
			});
			expect(stored).toMatchObject(fixture);
			expect(stored.checksum).toBe(createHash("sha256").update(bytes).digest("hex"));
			expect(await inspectVideoObject("users/u/a.mp4", stored, constraints)).toEqual(stored);
			expect(Buffer.from(backend.object!).equals(bytes)).toBe(true);
			expect(backend.completed).toBe(1);
			expect(backend.aborted).toBe(0);
		},
	);
	it.each([{ mediaBytes: 1000 }])(
		"rejects byte-limit violations before completing",
		async (fixture) => {
			await expect(
				transferVideoOutput({
					key: "users/u/a.mp4",
					url: "https://cdn.video.test/file",
					maxBytes: 100,
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
	it("preserves unexpected native audio under not-requested policy during transfer and recovery", async () => {
		const constraints = {
			productKey: "video-kling-3",
			durationSeconds: 5,
			sound: false,
			resolution: "720p",
			aspectRatio: "16:9",
			audioSafetyPolicy: { schemaVersion: 1 as const, mode: "not_requested" as const },
		};
		const bytes = mp4Fixture({ audio: true, mediaBytes: 30_000_000 });
		const stored = await transferVideoOutput({
			key: "users/u/silent.mp4",
			url: "https://cdn.video.test/file",
			maxBytes: 100 * 1024 * 1024,
			constraints,
			requestOptions: options(Readable.from([bytes])),
		});
		expect(stored).toMatchObject({ audioTracks: 1, audioTrackIds: [2] });
		expect(await inspectVideoObject("users/u/silent.mp4", stored, constraints)).toEqual(stored);
		expect(stored.checksum).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(Buffer.from(backend.object!).equals(bytes)).toBe(true);
		expect(backend.completed).toBe(1);
		expect(backend.aborted).toBe(0);
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

describe("persisted video inspection reuse", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		backend.etag = "sealed-etag";
		backend.readBytes = 0;
		backend.headDelayMs = 0;
		backend.fullDelayMs = 0;
		backend.probeDelayMs = 0;
	});
	afterEach(() => vi.useRealTimers());
	async function fixture(audio = false, mediaBytes = 6 * 1024 * 1024) {
		backend.object = mp4Fixture({ mediaBytes, audio });
		const constraints = videoOutputConstraints({
			productKey: "video-kling-3",
			duration: 5,
			sound: audio,
			resolution: "720p",
			aspectRatio: "16:9",
			audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
		});
		const stored = (await inspectVideoObject(
			"users/u/video/immutable.mp4",
			undefined,
			constraints,
		))!;
		const asset = {
			id: "asset",
			objectKey: "users/u/video/immutable.mp4",
			checksum: stored.checksum,
			storageEtag: stored.etag,
			byteSize: BigInt(stored.bytes),
			finalizedAt: new Date(),
			verificationEngine: "video-workflow-v1",
			kind: "OUTPUT",
			mimeType: "video/mp4",
			width: stored.width,
			height: stored.height,
			durationMillis: BigInt(stored.durationMillis),
		};
		const metadata = {
			durationMillis: stored.durationMillis,
			width: stored.width,
			height: stored.height,
			audioTracks: stored.audioTracks,
			audioTrackIds: stored.audioTrackIds ?? [],
			videoTracks: 1 as const,
		};
		const outputSpec = {
			...metadata,
			assetId: asset.id,
			checksum: stored.checksum,
			etag: stored.etag,
			report: createVideoOutputReport(stored, constraints),
			storageInspection: {
				schemaVersion: 1,
				verifier: "video-mp4-stream-v1",
				assetId: asset.id,
				objectKey: asset.objectKey,
				checksum: stored.checksum,
				etag: stored.etag,
				bytes: stored.bytes,
				checkedAt: asset.finalizedAt.toISOString(),
				constraints,
				metadata,
			},
		};
		vi.clearAllMocks();
		backend.readBytes = 0;
		return { asset, stored, constraints, outputSpec };
	}
	it("replaces two full inspections with two conditional bytes under fixed storage delays", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		backend.headDelayMs = 40;
		backend.fullDelayMs = 1000;
		backend.probeDelayMs = 100;
		const before = Date.now();
		const legacy = (async () => {
			await inspectVideoObject(f.asset.objectKey, f.stored, f.constraints);
			await inspectVideoObject(f.asset.objectKey, f.stored, f.constraints);
		})();
		await Promise.all([legacy, vi.runAllTimersAsync()]);
		expect(Date.now() - before).toBe(2080);
		expect(backend.readBytes).toBe(2 * f.stored.bytes);
		expect(headObject).toHaveBeenCalledTimes(2);
		vi.clearAllMocks();
		backend.readBytes = 0;
		const optimizedAt = Date.now();
		const optimized = (async () => [
			await inspectPersistedVideoObject(f.asset, f.outputSpec, f.constraints),
			await inspectPersistedVideoObject(f.asset, f.outputSpec, f.constraints),
		])();
		const [results] = await Promise.all([optimized, vi.runAllTimersAsync()]);
		expect(results).toEqual([
			{ ...f.stored, audioTrackIds: [] },
			{ ...f.stored, audioTrackIds: [] },
		]);
		expect(Date.now() - optimizedAt).toBe(200);
		expect(backend.readBytes).toBe(2);
		expect(headObject).not.toHaveBeenCalled();
		expect(readPrivateMediaStream).toHaveBeenCalledTimes(2);
		expect(readPrivateMediaStream).toHaveBeenCalledWith({
			bucket: "media",
			key: f.asset.objectKey,
			ifMatch: f.stored.etag,
			range: { start: 0, end: 0 },
		});
	});
	it.each([
		"legacy",
		"version",
		"asset",
		"key",
		"checksum",
		"etag",
		"bytes",
		"time",
		"constraints",
		"metadata",
		"report",
		"engine",
	])("fully reinspects %s evidence instead of trusting a partial receipt", async (change) => {
		const f = await fixture();
		const spec = structuredClone(f.outputSpec) as Record<string, unknown>;
		const receipt = spec.storageInspection as Record<string, unknown>;
		if (change === "legacy") delete spec.storageInspection;
		if (change === "version") receipt.schemaVersion = 2;
		if (change === "asset") receipt.assetId = "other";
		if (change === "key") receipt.objectKey = "other.mp4";
		if (change === "checksum") receipt.checksum = "0".repeat(64);
		if (change === "etag") receipt.etag = "other";
		if (change === "bytes") receipt.bytes = f.stored.bytes + 1;
		if (change === "time") receipt.checkedAt = new Date(0).toISOString();
		if (change === "constraints") receipt.constraints = { ...f.constraints, sound: true };
		if (change === "metadata")
			receipt.metadata = { ...f.outputSpec.storageInspection.metadata, width: 1 };
		if (change === "report") delete spec.report;
		if (change === "engine") f.asset.verificationEngine = "legacy";
		expect(await inspectPersistedVideoObject(f.asset, spec, f.constraints)).toEqual(f.stored);
		expect(headObject).toHaveBeenCalledTimes(1);
		expect(readPrivateMediaStream).toHaveBeenCalledExactlyOnceWith({
			bucket: "media",
			key: f.asset.objectKey,
			ifMatch: f.stored.etag,
		});
		expect(backend.readBytes).toBe(f.stored.bytes);
	});
	it("fails closed after a replacement rejects the original If-Match identity", async () => {
		const f = await fixture();
		backend.etag = "replaced";
		await expect(inspectPersistedVideoObject(f.asset, f.outputSpec, f.constraints)).rejects.toThrow(
			"VIDEO_STORED_IDENTITY_CHANGED",
		);
		expect(headObject).toHaveBeenCalledTimes(1);
		expect(backend.readBytes).toBe(0);
	});
	it("falls back to full inspection if the object store does not honor a bounded range", async () => {
		const f = await fixture();
		const cancel = vi.fn();
		vi.mocked(readPrivateMediaStream).mockResolvedValueOnce({
			contentLength: f.stored.bytes,
			contentType: "video/mp4",
			etag: f.stored.etag,
			body: new ReadableStream({ cancel }),
		});
		expect(await inspectPersistedVideoObject(f.asset, f.outputSpec, f.constraints)).toEqual(
			f.stored,
		);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(headObject).toHaveBeenCalledTimes(1);
		expect(backend.readBytes).toBe(f.stored.bytes);
	});
	it("does not adopt incomplete MP4 metadata after a transfer crash", async () => {
		const f = await fixture();
		backend.object = backend.object!.subarray(0, 20);
		await expect(inspectVideoObject(f.asset.objectKey)).rejects.toThrow();
		expect(headObject).toHaveBeenCalledTimes(1);
	});
	it("cannot reuse a receipt to bypass a historical required-audio size limit", async () => {
		const f = await fixture(true, 30_000_000);
		const historical = {
			...f.constraints,
			audioSafetyPolicy: { schemaVersion: 1 as const, mode: "required" as const },
		};
		await expect(inspectPersistedVideoObject(f.asset, f.outputSpec, historical)).rejects.toThrow(
			"VIDEO_AUDIO_MEDIA_TOO_LARGE",
		);
		expect(headObject).toHaveBeenCalledTimes(1);
		expect(readPrivateMediaStream).toHaveBeenCalledExactlyOnceWith({
			bucket: "media",
			key: f.asset.objectKey,
			ifMatch: f.stored.etag,
		});
	});
});
