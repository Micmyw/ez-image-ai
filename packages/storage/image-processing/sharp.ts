import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import sharp, { type Sharp } from "sharp";

import { MediaValidationError } from "../lib/media-signatures";
import { assertGuestImageDimensions, guestWatermarkGeometry, guestWatermarkSvg } from "./geometry";
import type { ImageProcessor, ImageWatermarkOptions } from "./types";

export function createSharpImageProcessor(): ImageProcessor {
	return {
		key: "sharp",
		async inspect(source, contentType) {
			// DOM and workerd declare different BYOB reader methods for the same Web stream.
			const readable = Readable.fromWeb(source as unknown as NodeReadableStream<Uint8Array>);
			const inspector = sharp({ sequentialRead: true, failOn: "error" });
			try {
				const [metadata] = await Promise.all([inspector.metadata(), pipeline(readable, inspector)]);
				if (`image/${metadata.format}` !== contentType || !metadata.width || !metadata.height) {
					throw new MediaValidationError(
						"OUTPUT_MEDIA_TYPE_MISMATCH",
						"Guest staging image metadata does not match its content",
					);
				}
				assertGuestImageDimensions(metadata.width, metadata.height);
				return { width: metadata.width, height: metadata.height };
			} finally {
				readable.destroy();
				inspector.destroy();
			}
		},
		async watermark(source, options) {
			const readable = Readable.fromWeb(source as unknown as NodeReadableStream<Uint8Array>);
			const transform = createGuestWatermarkTransform(options);
			readable.once("error", (error) => transform.destroy(error));
			transform.once("close", () => readable.destroy());
			return Readable.toWeb(readable.pipe(transform)) as unknown as ReadableStream<Uint8Array>;
		},
	};
}

export function createGuestWatermarkTransform(input: ImageWatermarkOptions): Sharp {
	const geometry = guestWatermarkGeometry(input.width, input.height);
	const pipeline = sharp({ sequentialRead: true, failOn: "error" }).composite([
		{
			input: Buffer.from(guestWatermarkSvg(geometry)),
			left: geometry.left,
			top: geometry.top,
			blend: "over",
		},
	]);
	switch (input.contentType) {
		case "image/jpeg":
			return pipeline.jpeg({ quality: 90, chromaSubsampling: "4:4:4", mozjpeg: false });
		case "image/png":
			return pipeline.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false });
		case "image/webp":
			return pipeline.webp({ quality: 90, alphaQuality: 100, smartSubsample: false });
	}
}
