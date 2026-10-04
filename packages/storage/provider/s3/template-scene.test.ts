import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	process.env.S3_ENDPOINT = "https://storage.test";
	process.env.S3_ACCESS_KEY_ID = "fixture";
	process.env.S3_SECRET_ACCESS_KEY = "fixture";
	process.env.MEDIA_BUCKET_NAME = "private-test";
	return { send: vi.fn(), remote: vi.fn() };
});
vi.mock("@aws-sdk/client-s3", async (original) => ({
	...(await original<typeof import("@aws-sdk/client-s3")>()),
	S3Client: class {
		send = mocks.send;
	},
}));
vi.mock("../../lib/stream-copy", async (original) => ({
	...(await original<typeof import("../../lib/stream-copy")>()),
	requestRemoteMediaStream: mocks.remote,
}));

import { storeImmutableVideoTemplateScene } from "./index";

function fixture(source: Buffer, contentType = "image/jpeg") {
	let stored: Buffer | null = null;
	const writes: Record<string, unknown>[] = [];
	mocks.remote.mockImplementation(async () => ({
		headers: { "content-type": contentType },
		stream: Readable.from([source]),
	}));
	mocks.send.mockImplementation(
		async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
			if (command.constructor.name === "PutObjectCommand") {
				writes.push(command.input);
				if (stored)
					throw Object.assign(new Error("immutable conflict"), { name: "PreconditionFailed" });
				stored = Buffer.from(command.input.Body as Buffer);
				return { ETag: "canonical", VersionId: "version-1" };
			}
			if (!stored) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
			const buffer = stored;
			const body = Object.assign(Readable.from([buffer]), {
				transformToWebStream: () =>
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(buffer);
							controller.close();
						},
					}),
			});
			return {
				Body: body,
				ContentLength: buffer.length,
				ContentType: "image/png",
				ETag: "canonical",
				VersionId: "version-1",
			};
		},
	);
	const run = (maximumBytes = 10_000_000) =>
		storeImmutableVideoTemplateScene({
			bucket: "media",
			key: "users/owner/video-templates/scene.png",
			sourceUrl: "https://cdn.example/scene",
			allowedHosts: ["cdn.example"],
			maximumBytes,
		});
	return { run, writes, bytes: () => stored! };
}
beforeEach(() => {
	mocks.send.mockReset();
	mocks.remote.mockReset();
});
describe("canonical private scene transfer (mock S3, real image decoder)", () => {
	it("rotates and strips EXIF, writes once conditionally, then reuses the same scene after recovery", async () => {
		const source = await sharp({
			create: { width: 160, height: 90, channels: 3, background: "orange" },
		})
			.jpeg()
			.withMetadata({ orientation: 6 })
			.toBuffer();
		const f = fixture(source);
		const result = await f.run();
		expect(result).toMatchObject({ width: 90, height: 160, etag: "canonical" });
		expect(result.sha256).toBe(createHash("sha256").update(f.bytes()).digest("hex"));
		const metadata = await sharp(f.bytes()).metadata();
		expect(metadata.format).toBe("png");
		expect(metadata.exif).toBeUndefined();
		expect(f.writes).toHaveLength(1);
		expect(f.writes[0]).toMatchObject({
			IfNoneMatch: "*",
			Key: "users/owner/video-templates/scene.png",
			ContentType: "image/png",
		});
		mocks.remote.mockRejectedValue(new Error("source changed or expired"));
		expect(await f.run()).toEqual(result);
		expect(mocks.remote).toHaveBeenCalledTimes(1);
		expect(f.writes).toHaveLength(1);
	});
	it("enforces the actual stream byte cap before any object write", async () => {
		const f = fixture(Buffer.alloc(1000));
		await expect(f.run(100)).rejects.toThrow("VIDEO_TEMPLATE_SCENE_TOO_LARGE");
		expect(f.writes).toHaveLength(0);
	});
	it("rejects corrupt image bytes even with the expected provider MIME", async () => {
		const f = fixture(Buffer.from("ffd8ffe000104a4649460000000000000000", "hex"));
		await expect(f.run()).rejects.toThrow();
		expect(f.writes).toHaveLength(0);
	});
});
