import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const s3 = vi.hoisted(() => {
	process.env.S3_ENDPOINT = "http://storage.test";
	process.env.S3_REGION = "us-east-1";
	process.env.S3_ACCESS_KEY_ID = "access";
	process.env.S3_SECRET_ACCESS_KEY = "secret";
	process.env.MEDIA_BUCKET_NAME = "media-private";
	return { send: vi.fn() };
});

vi.mock("@aws-sdk/client-s3", () => {
	class Command {
		input: Record<string, unknown>;
		constructor(input: Record<string, unknown>) {
			this.input = input;
		}
	}
	return {
		AbortMultipartUploadCommand: class AbortMultipartUploadCommand extends Command {},
		CompleteMultipartUploadCommand: class CompleteMultipartUploadCommand extends Command {},
		CreateMultipartUploadCommand: class CreateMultipartUploadCommand extends Command {},
		DeleteObjectCommand: class DeleteObjectCommand extends Command {},
		GetObjectCommand: class GetObjectCommand extends Command {},
		HeadBucketCommand: class HeadBucketCommand extends Command {},
		HeadObjectCommand: class HeadObjectCommand extends Command {},
		ListMultipartUploadsCommand: class ListMultipartUploadsCommand extends Command {},
		PutObjectCommand: class PutObjectCommand extends Command {},
		S3Client: class S3Client {
			send = (...args: unknown[]) => s3.send(...args);
		},
		UploadPartCommand: class UploadPartCommand extends Command {},
	};
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));

import {
	abortIncompleteMultipartUploads,
	inspectPrivateMediaObject,
	listMultipartUploads,
	promoteStagedObject,
	tryWriteImmutableGenerationImage,
	uploadMultipartPart,
} from "./index";

describe("stored private object inspection cleanup", () => {
	const bytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
	const input = {
		bucket: "media" as const,
		key: "users/test/assets/a/original.png",
		contentType: "image/png" as const,
		contentLength: bytes.length,
	};
	const metadata = { ContentLength: bytes.length, ContentType: "image/png" };
	beforeEach(() => s3.send.mockReset());
	it.each([
		{ ContentLength: undefined },
		{ ContentLength: 0 },
		{ ContentLength: Number.NaN },
		{ ContentLength: bytes.length + 1 },
		{ ContentLength: 26 * 1024 * 1024 },
		{ ContentType: "image/jpeg" },
	])("closes an unread Node response rejected by metadata %j", async (invalid) => {
		const read = vi.fn();
		const body = new Readable({ read });
		s3.send.mockResolvedValueOnce({ ...metadata, ...invalid, Body: body });
		await expect(inspectPrivateMediaObject(input)).rejects.toMatchObject({
			code: "ContentType" in invalid ? "OUTPUT_MEDIA_TYPE_MISMATCH" : "OUTPUT_MEDIA_SIZE_EXCEEDED",
		});
		expect(body.destroyed).toBe(true);
		expect(read).not.toHaveBeenCalled();
		expect(s3.send).toHaveBeenCalledTimes(1);
	});
	it("cancels an unread Web response rejected by MIME metadata", async () => {
		const cancel = vi.fn();
		const pull = vi.fn();
		const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
		s3.send.mockResolvedValueOnce({ ...metadata, ContentType: "text/html", Body: body });
		await expect(inspectPrivateMediaObject(input)).rejects.toMatchObject({
			code: "OUTPUT_MEDIA_TYPE_MISMATCH",
		});
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(pull).not.toHaveBeenCalled();
		expect(body.locked).toBe(false);
		expect(s3.send).toHaveBeenCalledTimes(1);
	});
	it("preserves validation failure when response cleanup fails", async () => {
		const cleanupError = new Error("response cleanup failed");
		const cancel = vi.fn(() => Promise.reject(cleanupError));
		const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
		s3.send.mockResolvedValueOnce({ ...metadata, ContentLength: 0, Body: body });
		await expect(inspectPrivateMediaObject(input)).rejects.toMatchObject({
			code: "OUTPUT_MEDIA_SIZE_EXCEEDED",
		});
		expect(cancel).toHaveBeenCalledTimes(1);
	});
	it("closes a non-iterable response before rejecting it", async () => {
		const destroy = vi.fn();
		s3.send.mockResolvedValueOnce({ ...metadata, Body: { destroy } });
		await expect(inspectPrivateMediaObject(input)).rejects.toMatchObject({
			code: "OUTPUT_MEDIA_SIZE_EXCEEDED",
		});
		expect(destroy).toHaveBeenCalledTimes(1);
	});
	it("preserves a read failure and closes the Node response", async () => {
		const readError = new Error("stored response interrupted");
		const body = new Readable({
			read() {
				this.destroy(readError);
			},
		});
		const destroy = vi.spyOn(body, "destroy");
		s3.send.mockResolvedValueOnce({ ...metadata, Body: body });
		await expect(inspectPrivateMediaObject(input)).rejects.toBe(readError);
		expect(body.destroyed).toBe(true);
		expect(destroy).toHaveBeenCalledTimes(1);
		expect(s3.send).toHaveBeenCalledTimes(1);
	});
	it("hashes every byte once and closes a successful Node response without auto-destroy", async () => {
		const body = Readable.from([bytes.subarray(0, 8), bytes.subarray(8)], { autoDestroy: false });
		const destroy = vi.spyOn(body, "destroy");
		s3.send.mockResolvedValueOnce({ ...metadata, Body: body, ETag: "immutable-etag" });
		await expect(inspectPrivateMediaObject(input)).resolves.toEqual({
			bytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			etag: "immutable-etag",
			versionId: null,
		});
		expect(body.destroyed).toBe(true);
		expect(destroy).toHaveBeenCalledTimes(1);
		expect(s3.send).toHaveBeenCalledTimes(1);
	});
	it("fully validates a successful Web response without an extra read or source cancellation", async () => {
		const cancel = vi.fn();
		const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
			controller.enqueue(bytes);
			controller.close();
		});
		const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
		s3.send.mockResolvedValueOnce({ ...metadata, Body: body });
		await expect(inspectPrivateMediaObject(input)).resolves.toMatchObject({
			bytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		});
		expect(body.locked).toBe(false);
		expect(pull).toHaveBeenCalledTimes(1);
		expect(cancel).not.toHaveBeenCalled();
		expect(s3.send).toHaveBeenCalledTimes(1);
	});
});

describe("multipart part cancellation", () => {
	beforeEach(() => s3.send.mockReset());
	it("forwards the transfer abort signal to the storage request", async () => {
		const controller = new AbortController();
		const body = Buffer.from("part");
		s3.send.mockResolvedValue({ ETag: "part-etag" });
		await expect(
			uploadMultipartPart({
				bucket: "media",
				key: "users/u/assets/a/original.mp4",
				uploadId: "upload-1",
				partNumber: 1,
				body,
				signal: controller.signal,
			}),
		).resolves.toBe("part-etag");
		expect(s3.send).toHaveBeenCalledWith(
			expect.objectContaining({ input: expect.objectContaining({ Body: body, PartNumber: 1 }) }),
			{ abortSignal: controller.signal },
		);
	});
});

describe("single private generation image", () => {
	const body = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
	const missing = () => Object.assign(new Error("missing"), { name: "NoSuchKey" });
	const stored = (bytes = body) => ({
		Body: Readable.from([bytes]),
		ContentLength: bytes.length,
		ContentType: "image/png",
		ETag: "fixed",
	});
	beforeEach(() => s3.send.mockReset());
	it("refuses inline buffers in a concurrent streaming-only executor", async () => {
		const reserve = vi.fn(async () => undefined);
		await expect(
			tryWriteImmutableGenerationImage({
				bucket: "media",
				key: "users/test/assets/a/original.png",
				contentType: "image/png",
				body,
				reserve,
				streamingOnly: true,
			}),
		).resolves.toBeNull();
		expect(reserve).not.toHaveBeenCalled();
		expect(s3.send).not.toHaveBeenCalled();
	});
	it("reserves before one conditional final write, without staging or promotion", async () => {
		const reserve = vi.fn(async () => {
			expect(s3.send).toHaveBeenCalledTimes(1);
		});
		s3.send.mockRejectedValueOnce(missing()).mockResolvedValueOnce({ ETag: "fixed" });
		const result = await tryWriteImmutableGenerationImage({
			bucket: "media",
			key: "users/test/assets/a/original.png",
			contentType: "image/png",
			body,
			reserve,
		});
		expect(result?.bytes).toBe(body.length);
		expect(reserve).toHaveBeenCalledWith(body.length);
		expect(s3.send.mock.calls[1]![0]).toMatchObject({
			input: { IfNoneMatch: "*", Body: body, Key: "users/test/assets/a/original.png" },
		});
		expect(s3.send).toHaveBeenCalledTimes(2);
	});
	it("starts a newly claimed asset with one conditional PUT and no missing-object GET", async () => {
		const reserve = vi.fn(async () => {
			expect(s3.send).not.toHaveBeenCalled();
		});
		s3.send.mockResolvedValueOnce({ ETag: "fixed" });
		const result = await tryWriteImmutableGenerationImage({
			bucket: "media",
			key: "users/test/assets/a/original.png",
			contentType: "image/png",
			body,
			freshClaim: true,
			reserve,
		});
		expect(result).toMatchObject({
			bytes: body.length,
			sha256: createHash("sha256").update(body).digest("hex"),
		});
		expect(s3.send).toHaveBeenCalledTimes(1);
		expect(s3.send.mock.calls[0]![0]).toMatchObject({
			input: { IfNoneMatch: "*", Body: body, Key: "users/test/assets/a/original.png" },
		});
	});
	it.each([undefined, false])(
		"keeps canonical-object recovery first when freshClaim is %s",
		async (freshClaim) => {
			s3.send.mockResolvedValueOnce(stored());
			const result = await tryWriteImmutableGenerationImage({
				bucket: "media",
				key: "users/test/assets/a/original.png",
				contentType: "image/png",
				body: Buffer.concat([body, Buffer.from("changed provider")]),
				freshClaim,
				reserve: async () => undefined,
			});
			expect(result?.sha256).toBe(createHash("sha256").update(body).digest("hex"));
			expect(s3.send).toHaveBeenCalledTimes(1);
			expect(s3.send.mock.calls[0]![0].constructor.name).toBe("GetObjectCommand");
		},
	);
	it.each([
		Object.assign(new Error("conflict"), { name: "PreconditionFailed" }),
		Object.assign(new Error("write outcome unknown"), { name: "TimeoutError" }),
		Object.assign(new Error("storage failure"), { $metadata: { httpStatusCode: 503 } }),
	])(
		"reads and hashes the full canonical winner after a fresh PUT reports $message",
		async (error) => {
			const original = Buffer.concat([body, Buffer.from("original canonical bytes")]);
			s3.send.mockRejectedValueOnce(error).mockResolvedValueOnce({
				...stored(original),
				Metadata: { sha256: "f".repeat(64) },
			});
			const reserve = vi.fn(async (_bytes: number) => undefined);
			const result = await tryWriteImmutableGenerationImage({
				bucket: "media",
				key: "users/test/assets/a/original.png",
				contentType: "image/png",
				body,
				freshClaim: true,
				reserve,
			});
			expect(result).toMatchObject({
				bytes: original.length,
				sha256: createHash("sha256").update(original).digest("hex"),
			});
			expect(s3.send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
				"PutObjectCommand",
				"GetObjectCommand",
			]);
			expect(reserve.mock.calls.map(([bytes]) => bytes)).toEqual([body.length, original.length]);
		},
	);
	it("preserves an unknown fresh PUT failure when no canonical winner exists", async () => {
		const error = new Error("connection closed after PUT");
		s3.send.mockRejectedValueOnce(error).mockRejectedValueOnce(missing());
		await expect(
			tryWriteImmutableGenerationImage({
				bucket: "media",
				key: "users/test/assets/a/original.png",
				contentType: "image/png",
				body,
				freshClaim: true,
				reserve: async () => undefined,
			}),
		).rejects.toBe(error);
		expect(s3.send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
			"PutObjectCommand",
			"GetObjectCommand",
		]);
	});
	it("rejects a truncated canonical winner even with a plausible ETag and checksum header", async () => {
		s3.send
			.mockRejectedValueOnce(
				Object.assign(new Error("conflict"), { $metadata: { httpStatusCode: 412 } }),
			)
			.mockResolvedValueOnce({
				...stored(),
				ContentLength: body.length + 1,
				Metadata: { sha256: "a".repeat(64) },
			});
		await expect(
			tryWriteImmutableGenerationImage({
				bucket: "media",
				key: "users/test/assets/a/original.png",
				contentType: "image/png",
				body,
				freshClaim: true,
				reserve: async () => undefined,
			}),
		).rejects.toMatchObject({ code: "OUTPUT_MEDIA_SIZE_EXCEEDED" });
		expect(s3.send).toHaveBeenCalledTimes(2);
	});
	it("does not read or write storage after a fresh claim loses its quota/lease fence", async () => {
		await expect(
			tryWriteImmutableGenerationImage({
				bucket: "media",
				key: "users/test/assets/a/original.png",
				contentType: "image/png",
				body,
				freshClaim: true,
				reserve: async () => {
					throw new Error("FENCE_LOST");
				},
			}),
		).rejects.toThrow("FENCE_LOST");
		expect(s3.send).not.toHaveBeenCalled();
	});
	it("does not turn local body validation or a definitive access denial into recovery", async () => {
		const input = {
			bucket: "media" as const,
			key: "users/test/assets/a/original.png",
			contentType: "image/png" as const,
			freshClaim: true,
			reserve: async () => undefined,
		};
		await expect(
			tryWriteImmutableGenerationImage({ ...input, body: Buffer.from("invalid image") }),
		).rejects.toMatchObject({ code: "OUTPUT_MEDIA_TYPE_UNSUPPORTED" });
		expect(s3.send).not.toHaveBeenCalled();
		const denied = Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } });
		s3.send.mockRejectedValueOnce(denied);
		await expect(tryWriteImmutableGenerationImage({ ...input, body })).rejects.toBe(denied);
		expect(s3.send).toHaveBeenCalledTimes(1);
	});
	it("recovers the same stored content after a DB failure without writing again", async () => {
		s3.send.mockResolvedValueOnce(stored());
		const reserve = vi.fn(async () => undefined);
		const result = await tryWriteImmutableGenerationImage({
			bucket: "media",
			key: "users/test/assets/a/original.png",
			contentType: "image/png",
			body: Buffer.concat([body, Buffer.from("changed provider")]),
			reserve,
		});
		expect(result?.sha256).toBe(createHash("sha256").update(body).digest("hex"));
		expect(s3.send).toHaveBeenCalledTimes(1);
		expect(reserve).toHaveBeenCalledWith(body.length);
	});
	it("re-reads the immutable winner on a conditional conflict", async () => {
		s3.send
			.mockRejectedValueOnce(missing())
			.mockRejectedValueOnce(Object.assign(new Error("conflict"), { name: "PreconditionFailed" }))
			.mockResolvedValueOnce(stored());
		const reserve = vi.fn(async () => undefined);
		const result = await tryWriteImmutableGenerationImage({
			bucket: "media",
			key: "users/test/assets/a/original.png",
			contentType: "image/png",
			body,
			reserve,
		});
		expect(result?.etag).toBe("fixed");
		expect(s3.send).toHaveBeenCalledTimes(3);
		expect(reserve).toHaveBeenCalledTimes(2);
	});
	it("never writes after a lost transfer fence or quota rejection", async () => {
		s3.send.mockRejectedValueOnce(missing());
		await expect(
			tryWriteImmutableGenerationImage({
				bucket: "media",
				key: "users/test/assets/a/original.png",
				contentType: "image/png",
				body,
				reserve: async () => {
					throw new Error("FENCE_LOST");
				},
			}),
		).rejects.toThrow("FENCE_LOST");
		expect(s3.send).toHaveBeenCalledTimes(1);
	});
});

describe("promoteStagedObject", () => {
	beforeEach(() => {
		s3.send.mockReset();
	});

	it("promotes small generated images with one conditional PUT and no reread", async () => {
		const body = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
		s3.send
			.mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "NoSuchKey" }))
			.mockResolvedValueOnce({
				Body: Readable.from([body]),
				ContentLength: body.length,
				ContentType: "image/png",
			})
			.mockResolvedValueOnce({ ETag: "immutable-etag" });
		const result = await promoteStagedObject({
			staging: { bucket: "media", key: "users/test/staging/one" },
			final: { bucket: "media", key: "users/test/final/one" },
			contentLength: body.length,
			contentType: "image/png",
			preferSinglePut: true,
		});
		expect(result).toEqual({
			bytes: body.length,
			sha256: createHash("sha256").update(body).digest("hex"),
			etag: "immutable-etag",
			versionId: null,
		});
		expect(s3.send).toHaveBeenCalledTimes(3);
		expect(s3.send.mock.calls[2]![0]).toMatchObject({ input: { IfNoneMatch: "*", Body: body } });
	});

	it("rejects a small output checksum mismatch before writing the final object", async () => {
		const body = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
		s3.send
			.mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "NoSuchKey" }))
			.mockResolvedValueOnce({
				Body: Readable.from([body]),
				ContentLength: body.length,
				ContentType: "image/png",
			});
		await expect(
			promoteStagedObject({
				staging: { bucket: "media", key: "users/test/staging/one" },
				final: { bucket: "media", key: "users/test/final/one" },
				contentLength: body.length,
				contentType: "image/png",
				preferSinglePut: true,
				expectedSha256: "a".repeat(64),
			}),
		).rejects.toThrow("UPLOAD_CHECKSUM_MISMATCH");
		expect(s3.send).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ name: "AccessDenied", status: 403 },
		{ name: "TooManyRequests", status: 429 },
		{ name: "InternalError", status: 500 },
		{ name: "TimeoutError", status: undefined },
	])("fails closed when inspecting a final object returns $name", async ({ name, status }) => {
		const failure = Object.assign(new Error(name), {
			name,
			$metadata: status === undefined ? undefined : { httpStatusCode: status },
		});
		s3.send.mockRejectedValue(failure);

		await expect(
			promoteStagedObject({
				staging: { bucket: "media", key: "users/user_1/staging/session_1/nonce.png" },
				final: { bucket: "media", key: "users/user_1/assets/asset_1/original.png" },
				contentType: "image/png",
				contentLength: 16,
			}),
		).rejects.toBe(failure);

		expect(s3.send).toHaveBeenCalledTimes(1);
	});

	it("recovers from a conditional final-write conflict by inspecting the stored final object", async () => {
		const content = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
		const notFound = Object.assign(new Error("missing"), {
			name: "NoSuchKey",
			$metadata: { httpStatusCode: 404 },
		});
		const conflict = Object.assign(new Error("already finalized"), {
			name: "PreconditionFailed",
			$metadata: { httpStatusCode: 412 },
		});
		s3.send
			.mockRejectedValueOnce(notFound)
			.mockResolvedValueOnce({
				Body: Readable.from([content]),
				ContentLength: content.byteLength,
				ContentType: "image/png",
			})
			.mockResolvedValueOnce({ UploadId: "final-upload" })
			.mockResolvedValueOnce({ ETag: "part-etag" })
			.mockRejectedValueOnce(conflict)
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({
				Body: Readable.from([content]),
				ContentLength: content.byteLength,
				ContentType: "image/png",
				ETag: "final-etag",
				VersionId: "final-version",
			});

		await expect(
			promoteStagedObject({
				staging: { bucket: "media", key: "users/user_1/staging/session_1/nonce.png" },
				final: { bucket: "media", key: "users/user_1/assets/asset_1/original.png" },
				contentType: "image/png",
				contentLength: content.byteLength,
			}),
		).resolves.toEqual({
			bytes: content.byteLength,
			sha256: createHash("sha256").update(content).digest("hex"),
			etag: "final-etag",
			versionId: "final-version",
		});
		expect(s3.send).toHaveBeenCalledTimes(7);
	});

	it("returns the immutable final identity when a recovered output has different bytes", async () => {
		const existing = Buffer.concat([
			Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
			Buffer.from("stale-final-output"),
		]);
		s3.send.mockResolvedValueOnce({
			Body: Readable.from([existing]),
			ContentLength: existing.byteLength,
			ContentType: "image/png",
			ETag: "immutable-final-etag",
			VersionId: "immutable-final-version",
		});

		await expect(
			promoteStagedObject({
				staging: { bucket: "media", key: "users/user_1/staging/session_1/retry.png" },
				final: { bucket: "media", key: "users/user_1/assets/asset_1/original.png" },
				contentType: "image/png",
				contentLength: 16,
				acceptExistingFinalIdentity: true,
			}),
		).resolves.toEqual({
			bytes: existing.byteLength,
			sha256: createHash("sha256").update(existing).digest("hex"),
			etag: "immutable-final-etag",
			versionId: "immutable-final-version",
		});
		expect(s3.send).toHaveBeenCalledTimes(1);
	});

	it("rejects an immutable final object whose checksum differs from the guest declaration", async () => {
		const existing = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
		s3.send.mockResolvedValueOnce({
			Body: Readable.from([existing]),
			ContentLength: existing.byteLength,
			ContentType: "image/png",
		});

		await expect(
			promoteStagedObject({
				staging: { bucket: "media", key: "users/guest/staging/session/nonce.png" },
				final: { bucket: "media", key: "users/guest/assets/asset/original.png" },
				contentType: "image/png",
				contentLength: existing.byteLength,
				expectedSha256: "0".repeat(64),
			}),
		).rejects.toMatchObject({ code: "OUTPUT_MEDIA_TYPE_MISMATCH", retryable: false });
		expect(s3.send).toHaveBeenCalledTimes(1);
	});

	it("records a newly created final multipart upload before its first part is copied", async () => {
		const content = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
		const notFound = Object.assign(new Error("missing"), {
			name: "NoSuchKey",
			$metadata: { httpStatusCode: 404 },
		});
		let persisted = false;
		s3.send
			.mockRejectedValueOnce(notFound)
			.mockResolvedValueOnce({
				Body: Readable.from([content]),
				ContentLength: content.byteLength,
				ContentType: "image/png",
			})
			.mockResolvedValueOnce({ UploadId: "durable-final-upload" })
			.mockResolvedValueOnce({ ETag: "part-etag" })
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({
				Body: Readable.from([content]),
				ContentLength: content.byteLength,
				ContentType: "image/png",
				ETag: "final-etag",
			});

		await expect(
			promoteStagedObject({
				staging: { bucket: "media", key: "users/user_1/staging/session_1/nonce.png" },
				final: { bucket: "media", key: "users/user_1/assets/asset_1/original.png" },
				contentType: "image/png",
				contentLength: content.byteLength,
				promotion: {
					onMultipartUploadCreated: async ({ uploadId }) => {
						expect(uploadId).toBe("durable-final-upload");
						persisted = true;
					},
				},
			}),
		).resolves.toMatchObject({ bytes: content.byteLength });
		expect(persisted).toBe(true);
	});

	it("reuses a persisted final multipart upload without creating a replacement", async () => {
		const content = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
		const notFound = Object.assign(new Error("missing"), {
			name: "NoSuchKey",
			$metadata: { httpStatusCode: 404 },
		});
		s3.send
			.mockRejectedValueOnce(notFound)
			.mockResolvedValueOnce({
				Body: Readable.from([content]),
				ContentLength: content.byteLength,
				ContentType: "image/png",
			})
			.mockResolvedValueOnce({ ETag: "part-etag" })
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({
				Body: Readable.from([content]),
				ContentLength: content.byteLength,
				ContentType: "image/png",
				ETag: "final-etag",
			});

		await expect(
			promoteStagedObject({
				staging: { bucket: "media", key: "users/user_1/staging/session_1/nonce.png" },
				final: { bucket: "media", key: "users/user_1/assets/asset_1/original.png" },
				contentType: "image/png",
				contentLength: content.byteLength,
				promotion: { uploadId: "persisted-final-upload" },
			}),
		).resolves.toMatchObject({ bytes: content.byteLength });
		expect(s3.send).toHaveBeenCalledTimes(5);
	});

	it("lists and aborts only incomplete multipart uploads for the exact final key", async () => {
		const exactKey = "users/user_1/assets/asset_1/original.png";
		s3.send
			.mockResolvedValueOnce({
				Uploads: [
					{ Key: exactKey, UploadId: "exact-first" },
					{ Key: `${exactKey}.other`, UploadId: "wrong-prefix" },
				],
				IsTruncated: true,
				NextKeyMarker: exactKey,
				NextUploadIdMarker: "exact-first",
			})
			.mockResolvedValueOnce({
				Uploads: [
					{ Key: exactKey, UploadId: "exact-second" },
					{ Key: "users/user_1/assets/other/original.png", UploadId: "wrong-key" },
				],
				IsTruncated: false,
			})
			.mockResolvedValueOnce({
				Uploads: [
					{ Key: exactKey, UploadId: "exact-first" },
					{ Key: `${exactKey}.other`, UploadId: "wrong-prefix" },
				],
				IsTruncated: true,
				NextKeyMarker: exactKey,
				NextUploadIdMarker: "exact-first",
			})
			.mockResolvedValueOnce({
				Uploads: [
					{ Key: exactKey, UploadId: "exact-second" },
					{ Key: "users/user_1/assets/other/original.png", UploadId: "wrong-key" },
				],
				IsTruncated: false,
			})
			.mockResolvedValue({});

		await expect(listMultipartUploads({ bucket: "media", key: exactKey })).resolves.toEqual([
			"exact-first",
			"exact-second",
		]);
		await expect(abortIncompleteMultipartUploads({ bucket: "media", key: exactKey })).resolves.toBe(
			2,
		);
	});
});
