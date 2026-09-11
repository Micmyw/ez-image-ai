import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import {
	createCloudflareImagesProcessor,
	type CloudflareImagesBinding,
	type CloudflareImagesTransformer,
} from "./cloudflare-images";

function stream(bytes: Uint8Array = new Uint8Array([1, 2, 3])): ReadableStream<Uint8Array> {
	return new Blob([Uint8Array.from(bytes)]).stream();
}

function bindingDouble(
	options: {
		metadata?: { format: string; width?: number; height?: number; fileSize?: number };
		outputType?: string;
		failure?: Error;
	} = {},
) {
	const draws: Array<{
		image: CloudflareImagesTransformer | ReadableStream<Uint8Array>;
		options: unknown;
	}> = [];
	const transforms: unknown[] = [];
	const inputBytes: Promise<Uint8Array>[] = [];
	const outputs: unknown[] = [];
	const transformer: CloudflareImagesTransformer = {
		transform(input) {
			transforms.push(input);
			return transformer;
		},
		draw(image, drawOptions) {
			draws.push({ image, options: drawOptions });
			return transformer;
		},
		async output(input) {
			outputs.push(input);
			await Promise.all(inputBytes);
			if (options.failure) throw options.failure;
			return {
				contentType: () => options.outputType ?? input.format,
				image: () => stream(new Uint8Array([7, 8, 9])),
			};
		},
	};
	const binding: CloudflareImagesBinding = {
		async info(source) {
			await new Response(source).arrayBuffer();
			return options.metadata ?? { format: "image/png", width: 640, height: 400, fileSize: 3 };
		},
		input(source) {
			inputBytes.push(new Response(source).bytes());
			return transformer;
		},
	};
	return { binding, draws, transforms, inputBytes, outputs };
}

describe("Cloudflare Images processor", () => {
	it("keeps EzPic lettering proportional on an extreme panoramic image", async () => {
		const bytes = await sharp({
			create: { width: 12_000, height: 64, channels: 3, background: "#202020" },
		})
			.png()
			.toBuffer();
		const processor = createCloudflareImagesProcessor(rasterizingBindingDouble());
		const output = await processor.watermark(stream(bytes), {
			width: 12_000,
			height: 64,
			contentType: "image/png",
		});
		const pixels = await sharp(Buffer.from(await new Response(output).arrayBuffer()))
			.raw()
			.toBuffer({ resolveWithObject: true });
		let firstWhite = pixels.info.width;
		let lastWhite = 0;
		for (let offset = 0; offset < pixels.data.length; offset += pixels.info.channels) {
			if (
				pixels.data[offset]! > 245 &&
				pixels.data[offset + 1]! > 245 &&
				pixels.data[offset + 2]! > 245
			) {
				const x = (offset / pixels.info.channels) % pixels.info.width;
				firstWhite = Math.min(firstWhite, x);
				lastWhite = Math.max(lastWhite, x);
			}
		}
		expect(lastWhite - firstWhite).toBeGreaterThan(20);
		expect(lastWhite - firstWhite).toBeLessThan(120);
	});

	it("inspects private bytes without creating a transformation", async () => {
		const fake = bindingDouble();
		const processor = createCloudflareImagesProcessor(fake.binding);
		await expect(processor.inspect(stream(), "image/png", { contentLength: 3 })).resolves.toEqual({
			width: 640,
			height: 400,
		});
		expect(fake.outputs).toEqual([]);
		expect(fake.inputBytes).toEqual([]);
	});

	it.each(["image/jpeg", "image/png", "image/webp"] as const)(
		"draws the EzPic plate and lettering using private byte streams and returns %s",
		async (contentType) => {
			const fake = bindingDouble();
			const processor = createCloudflareImagesProcessor(fake.binding);
			const output = await processor.watermark(stream(), {
				width: 640,
				height: 400,
				contentType,
				contentLength: 3,
			});
			expect([...(await new Response(output).bytes())]).toEqual([7, 8, 9]);
			expect(fake.draws).toHaveLength(2);
			expect(fake.draws[0]?.options).toEqual({ left: 476, top: 344, composite: "over" });
			expect(fake.transforms[0]).toEqual({ width: 154, height: 46, fit: "squeeze" });
			expect(fake.outputs).toEqual([
				{
					format: contentType,
					anim: false,
					...(contentType === "image/png" ? {} : { quality: 90 }),
				},
			]);
			const sources = await Promise.all(fake.inputBytes);
			const overlay = sources.find((bytes) => bytes.length > 3);
			expect(overlay).toBeDefined();
			const pixels = await sharp(overlay).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
			expect(pixels.info.channels).toBe(4);
			expect(pixels.data[3]).toBe(0);
			const lettering = await sharp(sources[1]).raw().toBuffer();
			expect([...lettering].some((channel) => channel >= 250)).toBe(true);
		},
	);

	it.each([
		{
			format: "image/jpeg",
			width: 640,
			height: 400,
			fileSize: 3,
			code: "OUTPUT_MEDIA_TYPE_MISMATCH",
		},
		{ format: "image/svg+xml", code: "OUTPUT_MEDIA_TYPE_MISMATCH" },
		{
			format: "image/png",
			width: 12_001,
			height: 64,
			fileSize: 3,
			code: "CLOUDFLARE_IMAGES_DIMENSIONS_EXCEEDED",
		},
		{
			format: "image/png",
			width: 10_001,
			height: 10_000,
			fileSize: 3,
			code: "CLOUDFLARE_IMAGES_DIMENSIONS_EXCEEDED",
		},
		{
			format: "image/png",
			width: 640,
			height: 400,
			fileSize: 20_000_001,
			code: "CLOUDFLARE_IMAGES_SIZE_EXCEEDED",
		},
		{
			format: "image/png",
			width: 63,
			height: 64,
			fileSize: 3,
			code: "GUEST_WATERMARK_DIMENSIONS_INVALID",
		},
	])("rejects incompatible inspected metadata: $code", async ({ code, ...metadata }) => {
		const fake = bindingDouble({ metadata });
		await expect(
			createCloudflareImagesProcessor(fake.binding).inspect(stream(), "image/png"),
		).rejects.toMatchObject({ code, retryable: false, stage: "TRANSFER" });
		expect(fake.outputs).toEqual([]);
	});

	it("rejects known over-limit inputs before requesting a paid transformation", async () => {
		const fake = bindingDouble();
		await expect(
			createCloudflareImagesProcessor(fake.binding).watermark(stream(), {
				width: 640,
				height: 400,
				contentType: "image/png",
				contentLength: 20_000_001,
			}),
		).rejects.toMatchObject({ code: "CLOUDFLARE_IMAGES_SIZE_EXCEEDED" });
		expect(fake.outputs).toEqual([]);
	});

	it("rejects a stream that exceeds its declared private-object size", async () => {
		const fake = bindingDouble();
		await expect(
			createCloudflareImagesProcessor(fake.binding).watermark(stream(), {
				width: 640,
				height: 400,
				contentType: "image/png",
				contentLength: 2,
			}),
		).rejects.toMatchObject({ code: "IMAGE_PROCESSOR_SOURCE_SIZE_MISMATCH" });
	});

	it("cancels an unknown-length stream when it exceeds the Images input limit", async () => {
		const cancel = vi.fn();
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(1_000_000));
			},
			cancel,
		});
		const fake = bindingDouble();
		await expect(
			createCloudflareImagesProcessor(fake.binding).inspect(source, "image/png"),
		).rejects.toMatchObject({ code: "CLOUDFLARE_IMAGES_SIZE_EXCEEDED" });
		expect(cancel).toHaveBeenCalled();
	});

	it("propagates provider failure without returning the original stream", async () => {
		const failure = new Error("Images unavailable");
		const fake = bindingDouble({ failure });
		await expect(
			createCloudflareImagesProcessor(fake.binding).watermark(stream(), {
				width: 640,
				height: 400,
				contentType: "image/png",
			}),
		).rejects.toBe(failure);
	});

	it("rejects an output whose type differs from the reserved final object", async () => {
		const fake = bindingDouble({ outputType: "image/jpeg" });
		await expect(
			createCloudflareImagesProcessor(fake.binding).watermark(stream(), {
				width: 640,
				height: 400,
				contentType: "image/png",
			}),
		).rejects.toMatchObject({ code: "OUTPUT_MEDIA_TYPE_MISMATCH" });
	});
});

// This external binding double rasterizes only the documented operations used
// by our adapter, so assertions inspect output pixels instead of call counts.
function rasterizingBindingDouble(): CloudflareImagesBinding {
	type RasterHandle = CloudflareImagesTransformer & { render(): Promise<Buffer> };
	return {
		async info(source) {
			const bytes = Buffer.from(await new Response(source).arrayBuffer());
			const metadata = await sharp(bytes).metadata();
			return {
				format: `image/${metadata.format}`,
				width: metadata.width,
				height: metadata.height,
				fileSize: bytes.length,
			};
		},
		input(source) {
			const bytes = new Response(source).arrayBuffer();
			let dimensions: { width: number; height: number } | undefined;
			const layers: Array<{ image: RasterHandle; left: number; top: number }> = [];
			const handle: RasterHandle = {
				transform(options) {
					dimensions = options;
					return handle;
				},
				draw(image, options) {
					layers.push({ image: image as RasterHandle, left: options.left, top: options.top });
					return handle;
				},
				async render() {
					let image = sharp(Buffer.from(await bytes));
					if (dimensions)
						image = image.resize(dimensions.width, dimensions.height, { fit: "fill" });
					let current = await image.png().toBuffer();
					for (const layer of layers) {
						current = await sharp(current)
							.composite([{ input: await layer.image.render(), left: layer.left, top: layer.top }])
							.png()
							.toBuffer();
					}
					return current;
				},
				async output(options) {
					const output = await handle.render();
					return { contentType: () => options.format, image: () => stream(output) };
				},
			};
			return handle;
		},
	};
}
