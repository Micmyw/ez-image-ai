import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { runWithImageProcessor } from "./context";
import type { ImageProcessor } from "./types";

interface StorageCommand {
	constructor: { name: string };
	input: Record<string, unknown>;
}

const service = vi.hoisted(() => {
	process.env.S3_ENDPOINT = "https://storage.test";
	process.env.S3_ACCESS_KEY_ID = "test-access";
	process.env.S3_SECRET_ACCESS_KEY = "test-secret";
	process.env.MEDIA_BUCKET_NAME = "private-media";
	return { send: vi.fn<(command: StorageCommand) => Promise<unknown>>() };
});

vi.mock("@aws-sdk/client-s3", async (importOriginal) => ({
	...(await importOriginal<typeof import("@aws-sdk/client-s3")>()),
	S3Client: class {
		send = service.send;
	},
}));

import { watermarkStagedGuestImage } from "../provider/s3";

const stagingKey = "users/guest/staging/clean.png";
const finalKey = "users/guest/assets/output/original.png";
const sourceBytes = Buffer.from("89504e470d0a1a0a0000000d4948445201020304", "hex");
const watermarkedBytes = Buffer.from("89504e470d0a1a0a0000000d4948445205060708", "hex");
const input = {
	staging: { bucket: "media" as const, key: stagingKey },
	final: { bucket: "media" as const, key: finalKey },
	contentType: "image/png" as const,
	deleteAfter: new Date("2026-08-29T00:00:00.000Z"),
	now: () => new Date("2026-08-28T00:00:00.000Z"),
};

function storageDouble(options: { conflict?: boolean; finalBytes?: Buffer } = {}) {
	const objects = new Map<string, Buffer>([[stagingKey, sourceBytes]]);
	if (options.finalBytes) objects.set(finalKey, options.finalBytes);
	const openUploads = new Set<string>();
	const parts: Buffer[] = [];
	const events: string[] = [];
	let conditionalWrite: unknown;
	service.send.mockImplementation(async (command) => {
		const key = String(command.input.Key);
		switch (command.constructor.name) {
			case "GetObjectCommand": {
				events.push(`read:${key}`);
				const bytes = objects.get(key);
				if (!bytes) throw new Error("Object missing");
				const body = Readable.from([bytes]);
				return {
					Body: Object.assign(body, { transformToWebStream: () => Readable.toWeb(body) }),
					ContentLength: bytes.byteLength,
					ContentType: "image/png",
					ETag: "stored-etag",
					VersionId: "stored-version",
				};
			}
			case "CreateMultipartUploadCommand":
				events.push("create-upload");
				openUploads.add("upload-1");
				return { UploadId: "upload-1" };
			case "UploadPartCommand":
				if (!Buffer.isBuffer(command.input.Body)) throw new Error("Expected byte stream part");
				parts.push(command.input.Body);
				return { ETag: "part-etag" };
			case "CompleteMultipartUploadCommand":
				conditionalWrite = command.input.IfNoneMatch;
				if (options.conflict)
					throw Object.assign(new Error("conflict"), {
						name: "PreconditionFailed",
						$metadata: { httpStatusCode: 412 },
					});
				objects.set(key, Buffer.concat(parts));
				openUploads.delete("upload-1");
				events.push("complete-upload");
				return {};
			case "AbortMultipartUploadCommand":
				openUploads.delete("upload-1");
				events.push("abort-upload");
				return {};
			case "DeleteObjectCommand":
				objects.delete(key);
				events.push(`delete:${key}`);
				return {};
			default:
				throw new Error(`Unexpected command ${command.constructor.name}`);
		}
	});
	return { objects, openUploads, events, conditionalWrite: () => conditionalWrite };
}

function processor(
	watermark: ImageProcessor["watermark"] = async () => new Blob([watermarkedBytes]).stream(),
): ImageProcessor {
	return {
		key: "test-image-processor",
		async inspect(source) {
			await new Response(source).arrayBuffer();
			return { width: 640, height: 400 };
		},
		watermark,
	};
}

describe("image processor private storage lifecycle", () => {
	beforeEach(() => {
		service.send.mockReset();
	});

	it("stores only transformed bytes conditionally and verifies them before deleting clean staging", async () => {
		const storage = storageDouble();
		const result = await runWithImageProcessor(processor(), () => watermarkStagedGuestImage(input));
		expect(storage.objects.get(finalKey)).toEqual(watermarkedBytes);
		expect(storage.objects.has(stagingKey)).toBe(false);
		expect(storage.openUploads.size).toBe(0);
		expect(storage.conditionalWrite()).toBe("*");
		expect(storage.events.slice(-2)).toEqual([`read:${finalKey}`, `delete:${stagingKey}`]);
		expect(result).toMatchObject({
			bytes: watermarkedBytes.byteLength,
			sha256: createHash("sha256").update(watermarkedBytes).digest("hex"),
			etag: "stored-etag",
			versionId: "stored-version",
		});
	});

	it("retains the staging object and creates no multipart upload when Images rejects processing", async () => {
		const storage = storageDouble();
		await expect(
			runWithImageProcessor(
				processor(async () => {
					throw new Error("Images unavailable");
				}),
				() => watermarkStagedGuestImage(input),
			),
		).rejects.toThrow("Images unavailable");
		expect(storage.objects.get(stagingKey)).toEqual(sourceBytes);
		expect(storage.objects.has(finalKey)).toBe(false);
		expect(storage.events).not.toContain("create-upload");
		expect(storage.openUploads.size).toBe(0);
	});

	it("aborts a final upload and retains staging if the returned transform stream fails", async () => {
		const storage = storageDouble();
		const failed = processor(
			async () =>
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.error(new Error("transformed stream failed"));
					},
				}),
		);
		await expect(
			runWithImageProcessor(failed, () => watermarkStagedGuestImage(input)),
		).rejects.toThrow("transformed stream failed");
		expect(storage.objects.get(stagingKey)).toEqual(sourceBytes);
		expect(storage.objects.has(finalKey)).toBe(false);
		expect(storage.events).toContain("abort-upload");
		expect(storage.openUploads.size).toBe(0);
	});

	it("recovers a conditional retry only when the existing final bytes have the same identity", async () => {
		const storage = storageDouble({ conflict: true, finalBytes: watermarkedBytes });
		await runWithImageProcessor(processor(), () => watermarkStagedGuestImage(input));
		expect(storage.objects.get(finalKey)).toEqual(watermarkedBytes);
		expect(storage.objects.has(stagingKey)).toBe(false);
		expect(storage.openUploads.size).toBe(0);
	});

	it("preserves clean staging if a different final image wins the conditional write", async () => {
		const storage = storageDouble({ conflict: true, finalBytes: sourceBytes });
		await expect(
			runWithImageProcessor(processor(), () => watermarkStagedGuestImage(input)),
		).rejects.toMatchObject({ code: "OUTPUT_MEDIA_TYPE_MISMATCH" });
		expect(storage.objects.get(stagingKey)).toEqual(sourceBytes);
		expect(storage.objects.get(finalKey)).toEqual(sourceBytes);
		expect(storage.openUploads.size).toBe(0);
	});
});
