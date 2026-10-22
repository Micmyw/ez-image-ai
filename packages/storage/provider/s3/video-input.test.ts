import { createHash } from "node:crypto";

import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	process.env.S3_ENDPOINT = "https://storage.test";
	process.env.S3_ACCESS_KEY_ID = "fixture";
	process.env.S3_SECRET_ACCESS_KEY = "fixture";
	process.env.MEDIA_BUCKET_NAME = "private-test";
	return { send: vi.fn() };
});
vi.mock("@aws-sdk/client-s3", async (original) => ({
	...(await original<typeof import("@aws-sdk/client-s3")>()),
	S3Client: class {
		send = mocks.send;
	},
}));

import { runWithImageProcessor } from "../../image-processing/context";
import { createSharpImageProcessor } from "../../image-processing/sharp";
import type { ImageContentType } from "../../image-processing/types";
import { inspectPrivateImage, normalizeVideoReferenceToPng } from "./index";

const source = { bucket: "media" as const, key: "users/owner/final/reference" };
const final = { bucket: "media" as const, key: `${source.key}.png` };

function objectResponse(
	body: Buffer,
	options: {
		contentType?: string;
		contentLength?: number;
		etag?: string | null;
		chunks?: Uint8Array[];
		keepOpen?: boolean;
	} = {},
) {
	const cancel = vi.fn();
	const chunks = options.chunks ?? [body];
	let offset = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (offset < chunks.length) controller.enqueue(chunks[offset++]);
				else if (!options.keepOpen) controller.close();
			},
			cancel,
		},
		{ highWaterMark: 0 },
	);
	return {
		cancel,
		stream,
		response: {
			Body: { transformToWebStream: () => stream },
			ContentType: options.contentType ?? "image/png",
			ContentLength: options.contentLength ?? body.length,
			ETag: options.etag === undefined ? "sealed-etag" : options.etag,
			VersionId: "version-1",
		},
	};
}

async function photo(format: "jpeg" | "png" | "webp" = "png", orientation?: number) {
	let image = sharp({ create: { width: 160, height: 90, channels: 3, background: "orange" } });
	if (orientation) image = image.withMetadata({ orientation });
	return image.toFormat(format).toBuffer();
}

function fixture(body: Buffer, contentType: ImageContentType = "image/webp") {
	const objects = new Map<string, { body: Buffer; contentType: ImageContentType; etag: string }>([
		[source.key, { body, contentType, etag: "source-etag" }],
	]);
	const writes: Record<string, unknown>[] = [];
	let winnerOnWrite: Buffer | undefined;
	mocks.send.mockImplementation(
		async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
			const key = String(command.input.Key);
			if (command.constructor.name === "PutObjectCommand") {
				writes.push(command.input);
				if (winnerOnWrite) {
					objects.set(key, { body: winnerOnWrite, contentType: "image/png", etag: "winner-etag" });
				}
				if (objects.has(key))
					throw Object.assign(new Error("immutable conflict"), { name: "PreconditionFailed" });
				objects.set(key, {
					body: Buffer.from(command.input.Body as Buffer),
					contentType: command.input.ContentType as ImageContentType,
					etag: "canonical-etag",
				});
				return { ETag: "canonical-etag", VersionId: "version-1" };
			}
			if (command.constructor.name !== "GetObjectCommand")
				throw new Error(`UNEXPECTED_STORAGE_ROUND_TRIP:${command.constructor.name}`);
			const stored = objects.get(key);
			if (!stored) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
			return objectResponse(stored.body, stored).response;
		},
	);
	return {
		objects,
		writes,
		conflictWith(winner: Buffer) {
			winnerOnWrite = winner;
		},
		run(options: { preserveDimensions?: boolean; maximumBytes?: number } = {}) {
			return normalizeVideoReferenceToPng({
				source,
				final,
				sourceBytes: body.length,
				sourceEtag: "source-etag",
				sourceContentType: contentType,
				maximumBytes: 10_000_000,
				...options,
			});
		},
	};
}

beforeEach(() => {
	mocks.send.mockReset();
});

describe("bounded private input validation (mock S3, real image decoder)", () => {
	it.each(["jpeg", "png", "webp"] as const)(
		"inspects and fully decodes %s from one ETag-bound GET",
		async (format) => {
			const body = await photo(format);
			const response = objectResponse(body, { contentType: `image/${format}` });
			mocks.send.mockResolvedValue(response.response);
			expect(
				await inspectPrivateImage({
					...source,
					contentType: `image/${format}`,
					contentLength: body.length,
					ifMatch: "sealed-etag",
				}),
			).toEqual({ width: 160, height: 90 });
			expect(mocks.send).toHaveBeenCalledTimes(1);
			expect(mocks.send.mock.calls[0][0].constructor.name).toBe("GetObjectCommand");
			expect(mocks.send.mock.calls[0][0].input).toMatchObject({
				Key: source.key,
				IfMatch: "sealed-etag",
			});
			expect(response.stream.locked).toBe(false);
		},
	);

	it("rejects truncated bytes despite readable PNG dimensions", async () => {
		const valid = await photo();
		const truncated = valid.subarray(0, Math.floor(valid.length / 2));
		expect((await sharp(truncated).metadata()).width).toBe(160);
		mocks.send.mockResolvedValue(objectResponse(truncated).response);
		await expect(
			inspectPrivateImage({ ...source, contentType: "image/png", contentLength: truncated.length }),
		).rejects.toThrow();
		expect(mocks.send).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ etag: "different-etag" },
		{ etag: null },
		{ contentType: "image/jpeg" },
		{ contentLength: 0 },
		{ contentLength: 10_000_001 },
	])("cancels identity mismatch before consuming the body: %j", async (options) => {
		const body = await photo();
		const response = objectResponse(body, options);
		mocks.send.mockResolvedValue(response.response);
		await expect(
			inspectPrivateImage({
				...source,
				contentType: "image/png",
				contentLength: body.length,
				ifMatch: "sealed-etag",
			}),
		).rejects.toThrow("VIDEO_INPUT_IDENTITY_MISMATCH");
		expect(response.cancel).toHaveBeenCalledOnce();
		expect(response.stream.locked).toBe(false);
	});

	it.each([0, -1, 10_000_001, Number.POSITIVE_INFINITY, 1.5])(
		"rejects an invalid declared size %s before storage access",
		async (contentLength) => {
			await expect(
				inspectPrivateImage({ ...source, contentType: "image/png", contentLength }),
			).rejects.toThrow("INPUT_TOO_LARGE");
			expect(mocks.send).not.toHaveBeenCalled();
		},
	);

	it("cancels a stream that exceeds its declared size without reading an open tail", async () => {
		const body = await photo();
		const response = objectResponse(body, { chunks: [body, Buffer.alloc(1)], keepOpen: true });
		mocks.send.mockResolvedValue(response.response);
		await expect(
			inspectPrivateImage({ ...source, contentType: "image/png", contentLength: body.length }),
		).rejects.toThrow("VIDEO_INPUT_IDENTITY_MISMATCH");
		expect(response.cancel).toHaveBeenCalledOnce();
		expect(response.stream.locked).toBe(false);
	});

	it("rejects a short stream with a forged content length", async () => {
		const body = await photo();
		mocks.send.mockResolvedValue(
			objectResponse(body, { chunks: [body.subarray(0, body.length - 1)] }).response,
		);
		await expect(
			inspectPrivateImage({ ...source, contentType: "image/png", contentLength: body.length }),
		).rejects.toThrow("VIDEO_INPUT_IDENTITY_MISMATCH");
	});

	it("requires an actual decoder even when image dimensions are available", async () => {
		const body = await photo();
		mocks.send.mockResolvedValue(objectResponse(body).response);
		await expect(
			runWithImageProcessor({ ...createSharpImageProcessor(), validateDecoded: undefined }, () =>
				inspectPrivateImage({ ...source, contentType: "image/png", contentLength: body.length }),
			),
		).rejects.toThrow("VIDEO_INPUT_DECODER_UNAVAILABLE");
	});
});

describe("reference normalization without duplicate object downloads", () => {
	it("returns decoded metadata from one source GET and one conditional PUT", async () => {
		const f = fixture(await photo("webp"));
		const result = await f.run({ preserveDimensions: true });
		const canonical = f.objects.get(final.key)!.body;
		expect(result).toEqual({
			bytes: canonical.length,
			sha256: createHash("sha256").update(canonical).digest("hex"),
			etag: "canonical-etag",
			versionId: "version-1",
			width: 160,
			height: 90,
		});
		expect(f.writes).toHaveLength(1);
		expect(f.writes[0]).toMatchObject({
			Key: final.key,
			IfNoneMatch: "*",
			ContentType: "image/png",
		});
		expect(mocks.send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
			"GetObjectCommand", // Read the sealed source once.
			"PutObjectCommand", // Arbitrate ownership without a preflight HEAD/GET.
		]);
	});

	it("preserves the ordinary-video geometry contract before writing", async () => {
		const f = fixture(await photo("webp", 6));
		await expect(f.run({ preserveDimensions: true })).rejects.toThrow(
			"VIDEO_INPUT_DIMENSIONS_CHANGED",
		);
		expect(f.writes).toHaveLength(0);
	});

	it.each(["jpeg", "png", "webp"] as const)(
		"canonicalizes and strips orientation for a template %s without rereading either object",
		async (format) => {
			const f = fixture(await photo(format, 6), `image/${format}`);
			const result = await f.run();
			expect(result).toMatchObject({ width: 90, height: 160 });
			const metadata = await sharp(f.objects.get(final.key)!.body).metadata();
			expect(metadata.orientation).toBeUndefined();
			expect(metadata.exif).toBeUndefined();
			expect(mocks.send).toHaveBeenCalledTimes(2);
		},
	);

	it("recovers the decoded immutable winner even after a template source was reclaimed", async () => {
		const f = fixture(await photo("jpeg", 6), "image/jpeg");
		const committed = await f.run();
		f.objects.delete(source.key);
		mocks.send.mockClear();
		expect(await f.run()).toEqual(committed);
		expect(mocks.send).toHaveBeenCalledTimes(2);
		expect(f.writes).toHaveLength(1);
	});

	it("rechecks ordinary-video dimensions against the existing immutable winner", async () => {
		const f = fixture(await photo("webp"));
		const winner = await sharp(await photo())
			.rotate(90)
			.png()
			.toBuffer();
		f.conflictWith(winner);
		await expect(f.run({ preserveDimensions: true })).rejects.toThrow(
			"VIDEO_INPUT_DIMENSIONS_CHANGED",
		);
		expect(f.writes).toHaveLength(1);
	});

	it("does not bypass ordinary geometry checks when the original is missing", async () => {
		const f = fixture(await photo("webp"));
		await f.run({ preserveDimensions: true });
		f.objects.delete(source.key);
		mocks.send.mockClear();
		await expect(f.run({ preserveDimensions: true })).rejects.toMatchObject({ name: "NoSuchKey" });
		expect(mocks.send).toHaveBeenCalledTimes(1);
	});

	it("does not treat source authorization failures as permission to recover a final object", async () => {
		const f = fixture(await photo("webp"));
		mocks.send.mockRejectedValueOnce(
			Object.assign(new Error("forbidden"), { name: "AccessDenied" }),
		);
		await expect(f.run()).rejects.toMatchObject({ name: "AccessDenied" });
		expect(mocks.send).toHaveBeenCalledTimes(1);
	});

	it("does not write a source with decodable dimensions but truncated pixel data", async () => {
		const valid = await photo();
		const f = fixture(valid.subarray(0, Math.floor(valid.length / 2)), "image/png");
		await expect(f.run()).rejects.toThrow();
		expect(f.writes).toHaveLength(0);
	});

	it("cancels an oversized normalized stream before writing or consuming its open tail", async () => {
		const sourceBody = await photo("webp");
		const f = fixture(sourceBody);
		const output = objectResponse(Buffer.alloc(sourceBody.length + 1), { keepOpen: true });
		await expect(
			runWithImageProcessor(
				{
					...createSharpImageProcessor(),
					async normalizePng(sourceStream) {
						await sourceStream.cancel();
						return output.stream;
					},
				},
				() => f.run({ maximumBytes: sourceBody.length }),
			),
		).rejects.toThrow("VIDEO_NORMALIZED_INPUT_TOO_LARGE");
		expect(output.cancel).toHaveBeenCalledOnce();
		expect(output.stream.locked).toBe(false);
		expect(f.writes).toHaveLength(0);
	});

	it("fully validates normalized bytes before the immutable write", async () => {
		const f = fixture(await photo("webp"));
		const valid = await photo();
		const output = objectResponse(valid.subarray(0, Math.floor(valid.length / 2)));
		await expect(
			runWithImageProcessor(
				{
					...createSharpImageProcessor(),
					async normalizePng(sourceStream) {
						await sourceStream.cancel();
						return output.stream;
					},
				},
				() => f.run(),
			),
		).rejects.toThrow();
		expect(f.writes).toHaveLength(0);
	});

	it("returns a conditional-write winner's checksum and dimensions, never the losing proposal", async () => {
		const f = fixture(await photo("webp"));
		const winner = await sharp({
			create: { width: 80, height: 72, channels: 3, background: "blue" },
		})
			.png()
			.toBuffer();
		f.conflictWith(winner);
		expect(await f.run()).toMatchObject({
			bytes: winner.length,
			sha256: createHash("sha256").update(winner).digest("hex"),
			etag: "winner-etag",
			width: 80,
			height: 72,
		});
		expect(mocks.send).toHaveBeenCalledTimes(3);
	});

	it("does not trust a conditional-write winner that only has a readable image header", async () => {
		const f = fixture(await photo("webp"));
		const valid = await photo();
		f.conflictWith(valid.subarray(0, Math.floor(valid.length / 2)));
		await expect(f.run()).rejects.toThrow();
	});

	it("rejects an existing winner whose metadata exceeds the bound before consuming it", async () => {
		const body = await photo("webp");
		const f = fixture(body);
		f.objects.delete(source.key);
		const response = objectResponse(await photo(), { contentLength: 10_000_001 });
		mocks.send.mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "NoSuchKey" }));
		mocks.send.mockResolvedValueOnce(response.response);
		await expect(f.run()).rejects.toThrow("INPUT_TOO_LARGE");
		expect(response.cancel).toHaveBeenCalledOnce();
		expect(f.writes).toHaveLength(0);
	});
});
