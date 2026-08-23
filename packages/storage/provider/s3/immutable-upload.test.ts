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
});
