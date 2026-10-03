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
	listMultipartUploads,
	promoteStagedObject,
	tryWriteImmutableGenerationImage,
} from "./index";

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
