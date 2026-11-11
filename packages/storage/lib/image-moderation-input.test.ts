import { createHash } from "node:crypto";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCloudflareImagesProcessor } from "../image-processing/cloudflare-images";
import { runWithImageProcessor } from "../image-processing/context";
import { createSharpImageProcessor } from "../image-processing/sharp";
import { preparePrivateImageModeration } from "./image-moderation-input";

const storage = vi.hoisted(() => ({
	read: vi.fn(),
	sign: vi.fn(async () => "https://private.test/immutable"),
}));
vi.mock("../provider/s3", () => ({
	readPrivateMediaStream: storage.read,
	createSignedReadUrl: storage.sign,
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

function fixture(bytes: Buffer, contentType: string, overrides: Record<string, unknown> = {}) {
	storage.read.mockImplementation(async () => ({
		body: new Blob([new Uint8Array(bytes)]).stream(),
		contentLength: bytes.length,
		contentType,
		etag: '"immutable"',
		...overrides,
	}));
	return {
		objectKey: "users/test/assets/immutable/image",
		checksum: createHash("sha256").update(bytes).digest("hex"),
		storageEtag: '"immutable"',
	};
}

describe("SeeAPI 2.0 private image preparation", () => {
	it.each(["svg", "gif"] as const)(
		"identity-checks the complete %s original and prepares a bounded review JPEG",
		async (format) => {
			const bytes =
				format === "svg"
					? Buffer.from(
							'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="red"/></svg>',
						)
					: await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
							raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
						})
							.gif({ loop: 0, delay: [200, 200] })
							.toBuffer();
			const source = fixture(bytes, format === "svg" ? "image/svg+xml" : "image/gif");
			const processor = createSharpImageProcessor();
			const prepare = vi.fn(processor.moderationJpeg!.bind(processor));
			await expect(
				runWithImageProcessor({ ...processor, moderationJpeg: prepare }, () =>
					preparePrivateImageModeration({ ...source, checksum: "f".repeat(64) }),
				),
			).rejects.toThrow("IMAGE_MODERATION_SOURCE_INVALID");
			expect(prepare).not.toHaveBeenCalled();
			const result = await runWithImageProcessor({ ...processor, moderationJpeg: prepare }, () =>
				preparePrivateImageModeration(source),
			);
			expect(prepare).toHaveBeenCalledOnce();
			const pixels = await sharp(Buffer.from(result.split(",")[1]!, "base64"))
				.raw()
				.toBuffer({ resolveWithObject: true });
			expect(pixels.info).toMatchObject({ width: 1568, height: 1568, channels: 3 });
			if (format === "gif") {
				for (const [x, channel] of [
					[392, 0],
					[1176, 2],
				]) {
					const offset = (784 * 1568 + x!) * 3;
					expect(pixels.data[offset + channel!]).toBeGreaterThan(240);
				}
			}
			expect(storage.sign).not.toHaveBeenCalled();
		},
	);
	it("rejects active SVG before invoking the existing moderation image processor", async () => {
		const bytes = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><script>alert(1)</script></svg>',
		);
		const processor = createSharpImageProcessor();
		const prepare = vi.fn(processor.moderationJpeg!.bind(processor));
		await expect(
			runWithImageProcessor({ ...processor, moderationJpeg: prepare }, () =>
				preparePrivateImageModeration(fixture(bytes, "image/svg+xml")),
			),
		).rejects.toThrow("static, self-contained");
		expect(prepare).not.toHaveBeenCalled();
	});
	it("supports a 21 MB original through the Workers remote transform and verifies its actual output", async () => {
		const jpeg = await sharp({
			create: { width: 280, height: 280, channels: 3, background: "white" },
		})
			.jpeg()
			.toBuffer();
		const original = Buffer.alloc(21_000_000);
		jpeg.copy(original);
		const prepared = await sharp(jpeg).resize(1568, 1568).jpeg().toBuffer();
		const input = fixture(original, "image/jpeg");
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(new Uint8Array(prepared), { headers: { "content-type": "image/jpeg" } }),
			);
		const processor = createCloudflareImagesProcessor({
			input() {
				throw new Error("The binding input limit must be respected");
			},
			async info(source) {
				const bytes = Buffer.from(await new Response(source).arrayBuffer());
				const metadata = await sharp(bytes).metadata();
				return {
					format: `image/${metadata.format}`,
					fileSize: bytes.length,
					width: metadata.width,
					height: metadata.height,
				};
			},
		});
		const result = await runWithImageProcessor(processor, () =>
			preparePrivateImageModeration(input),
		);
		expect(Buffer.from(result.split(",")[1]!, "base64")).toEqual(prepared);
		expect(storage.sign).toHaveBeenCalledWith({
			bucket: "media",
			key: input.objectKey,
			expiresIn: 300,
		});
		expect(fetcher).toHaveBeenCalledOnce();
		fetcher.mockClear();
		await expect(
			runWithImageProcessor(processor, () =>
				preparePrivateImageModeration({ ...input, checksum: "b".repeat(64) }),
			),
		).rejects.toThrow("IMAGE_MODERATION_SOURCE_INVALID");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each(["png", "jpeg", "webp"] as const)(
		"normalizes a small %s to a complete recommended-size JPEG",
		async (format) => {
			const bytes = await sharp({
				create: { width: 160, height: 90, channels: 4, background: "#ff0000" },
			})
				.toFormat(format)
				.toBuffer();
			const input = fixture(bytes, `image/${format}`);
			const url = await preparePrivateImageModeration(input);
			expect(url).toMatch(/^data:image\/jpeg;base64,/);
			const output = Buffer.from(url.split(",")[1]!, "base64");
			const pixels = await sharp(output).raw().toBuffer({ resolveWithObject: true });
			expect(pixels.info).toMatchObject({ width: 1568, height: 1568, channels: 3 });
			expect(output.length).toBeLessThan(16 * 1024 * 1024);
			const center = (784 * 1568 + 784) * 3;
			expect(pixels.data[center]).toBeGreaterThan(240);
			expect(pixels.data[center + 1]).toBeLessThan(15);
			expect([...pixels.data.subarray(0, 3)]).toEqual([255, 255, 255]);
			expect(storage.read).toHaveBeenCalledWith({
				bucket: "media",
				key: input.objectKey,
				ifMatch: input.storageEtag,
			});
			expect(storage.sign).not.toHaveBeenCalled();
		},
	);
	it.each([
		[4096, 2160],
		[8192, 512],
		[12000, 64],
	])("fits a %sx%s source without cropping", async (width, height) => {
		const bytes = await sharp({ create: { width, height, channels: 3, background: "#2266aa" } })
			.png()
			.toBuffer();
		const url = await preparePrivateImageModeration(fixture(bytes, "image/png"));
		expect(await sharp(Buffer.from(url.split(",")[1]!, "base64")).metadata()).toMatchObject({
			width: 1568,
			height: 1568,
			format: "jpeg",
		});
	});
	it("flattens transparent inputs onto white", async () => {
		const bytes = await sharp({
			create: { width: 280, height: 280, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
		})
			.png()
			.toBuffer();
		const url = await preparePrivateImageModeration(fixture(bytes, "image/png"));
		const output = await sharp(Buffer.from(url.split(",")[1]!, "base64"))
			.raw()
			.toBuffer();
		expect([...output.subarray(0, 3)]).toEqual([255, 255, 255]);
	});
	it("rejects a changed immutable source checksum", async () => {
		const bytes = await sharp({
			create: { width: 280, height: 280, channels: 3, background: "white" },
		})
			.png()
			.toBuffer();
		await expect(
			preparePrivateImageModeration({ ...fixture(bytes, "image/png"), checksum: "a".repeat(64) }),
		).rejects.toThrow("IMAGE_MODERATION_SOURCE_INVALID");
	});
	it("rejects an incomplete stored body and an oversized object", async () => {
		const bytes = Buffer.from("incomplete");
		await expect(
			preparePrivateImageModeration(
				fixture(bytes, "image/png", { contentLength: bytes.length + 1 }),
			),
		).rejects.toThrow();
		await expect(
			preparePrivateImageModeration(
				fixture(bytes, "image/png", { contentLength: 25 * 1024 * 1024 + 1 }),
			),
		).rejects.toThrow("IMAGE_MODERATION_SOURCE_INVALID");
	});
	it("rejects an unavailable transform that returns source dimensions", async () => {
		const bytes = await sharp({
			create: { width: 280, height: 280, channels: 3, background: "white" },
		})
			.jpeg()
			.toBuffer();
		const input = fixture(bytes, "image/jpeg");
		await expect(
			runWithImageProcessor(
				{ ...createSharpImageProcessor(), moderationJpeg: async (source) => source },
				() => preparePrivateImageModeration(input),
			),
		).rejects.toThrow("IMAGE_MODERATION_PREPARATION_FAILED");
	});
});
