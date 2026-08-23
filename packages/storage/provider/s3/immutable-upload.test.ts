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
		PutObjectCommand: class PutObjectCommand extends Command {},
		S3Client: class S3Client {
			send = s3.send;
		},
		UploadPartCommand: class UploadPartCommand extends Command {},
	};
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));

import { promoteStagedObject } from "./index";

describe("promoteStagedObject", () => {
	beforeEach(() => {
		s3.send.mockReset();
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
