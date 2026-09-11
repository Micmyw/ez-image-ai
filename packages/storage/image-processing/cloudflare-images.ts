import { assertGuestImageDimensions, guestWatermarkGeometry } from "./geometry";
import { ImageProcessingError, type ImageContentType, type ImageProcessor } from "./types";
import { GUEST_WATERMARK_PNG, GUEST_WATERMARK_TEXT } from "./watermark-assets";

// The binding has a tighter input limit than the existing 25 MiB storage limit.
// Use decimal MB conservatively; no resize, paid-service or Container fallback.
export const CLOUDFLARE_IMAGES_MAX_INPUT_BYTES = 20_000_000;
export const CLOUDFLARE_IMAGES_MAX_DIMENSION = 12_000;
export const CLOUDFLARE_IMAGES_MAX_PIXELS = 100_000_000;

export interface CloudflareImagesTransformer {
	transform(options: {
		width: number;
		height: number;
		fit: "squeeze";
	}): CloudflareImagesTransformer;
	draw(
		image: ReadableStream<Uint8Array> | CloudflareImagesTransformer,
		options: { left: number; top: number; composite: "over" },
	): CloudflareImagesTransformer;
	output(options: { format: ImageContentType; quality?: number; anim: false }): Promise<{
		contentType(): string;
		image(): ReadableStream<Uint8Array>;
	}>;
}

export interface CloudflareImagesBinding {
	info(
		source: ReadableStream<Uint8Array>,
	): Promise<{ format: string; fileSize?: number; width?: number; height?: number }>;
	input(source: ReadableStream<Uint8Array>): CloudflareImagesTransformer;
}

export function createCloudflareImagesProcessor(binding: CloudflareImagesBinding): ImageProcessor {
	return {
		key: "cloudflare-images",
		async inspect(source, contentType, options) {
			const bounded = boundedImageSource(source, options?.contentLength);
			try {
				const metadata = await binding.info(bounded);
				if (
					metadata.format !== contentType ||
					metadata.width === undefined ||
					metadata.height === undefined
				) {
					throw new ImageProcessingError("OUTPUT_MEDIA_TYPE_MISMATCH");
				}
				assertCloudflareImageDimensions(metadata.width, metadata.height);
				assertInputBytes(metadata.fileSize);
				return { width: metadata.width, height: metadata.height };
			} finally {
				if (!bounded.locked) await bounded.cancel().catch(() => undefined);
			}
		},
		async watermark(source, options) {
			assertCloudflareImageDimensions(options.width, options.height);
			const bounded = boundedImageSource(source, options.contentLength);
			try {
				const geometry = guestWatermarkGeometry(options.width, options.height);
				const overlay = binding.input(watermarkBytes("plate")).transform({
					width: geometry.plateWidth,
					height: geometry.plateHeight,
					fit: "squeeze",
				});
				// Scale lettering uniformly: a short panoramic image has a wide plate
				// but must retain the same font size as the original Sharp design.
				const textWidth = Math.max(
					1,
					Math.round(
						(GUEST_WATERMARK_TEXT.width * geometry.fontSize) / GUEST_WATERMARK_TEXT.fontSize,
					),
				);
				const textHeight = Math.max(
					1,
					Math.round(
						(GUEST_WATERMARK_TEXT.height * geometry.fontSize) / GUEST_WATERMARK_TEXT.fontSize,
					),
				);
				const text = binding
					.input(watermarkBytes("text"))
					.transform({ width: textWidth, height: textHeight, fit: "squeeze" });
				const output = await binding
					.input(bounded)
					.draw(overlay, { left: geometry.left, top: geometry.top, composite: "over" })
					.draw(text, {
						left: geometry.left + Math.round((geometry.plateWidth - textWidth) / 2),
						top: geometry.top + Math.round(geometry.plateHeight * 0.52 - textHeight / 2),
						composite: "over",
					})
					.output({
						format: options.contentType,
						anim: false,
						...(options.contentType === "image/png" ? {} : { quality: 90 }),
					});
				const image = output.image();
				if (output.contentType() !== options.contentType) {
					await image.cancel().catch(() => undefined);
					throw new ImageProcessingError("OUTPUT_MEDIA_TYPE_MISMATCH");
				}
				return image;
			} catch (error) {
				if (!bounded.locked) await bounded.cancel().catch(() => undefined);
				throw error;
			}
		},
	};
}

function assertCloudflareImageDimensions(width: number, height: number): void {
	assertGuestImageDimensions(width, height);
	if (
		width > CLOUDFLARE_IMAGES_MAX_DIMENSION ||
		height > CLOUDFLARE_IMAGES_MAX_DIMENSION ||
		width * height > CLOUDFLARE_IMAGES_MAX_PIXELS
	) {
		throw new ImageProcessingError("CLOUDFLARE_IMAGES_DIMENSIONS_EXCEEDED");
	}
}

function assertInputBytes(bytes: number | undefined): asserts bytes is number {
	if (
		!Number.isSafeInteger(bytes) ||
		!bytes ||
		bytes < 0 ||
		bytes > CLOUDFLARE_IMAGES_MAX_INPUT_BYTES
	) {
		throw new ImageProcessingError("CLOUDFLARE_IMAGES_SIZE_EXCEEDED");
	}
}

function boundedImageSource(
	source: ReadableStream<Uint8Array>,
	contentLength?: number,
): ReadableStream<Uint8Array> {
	if (contentLength !== undefined) assertInputBytes(contentLength);
	let bytes = 0;
	return source.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				bytes += chunk.byteLength;
				if (bytes > CLOUDFLARE_IMAGES_MAX_INPUT_BYTES) {
					throw new ImageProcessingError("CLOUDFLARE_IMAGES_SIZE_EXCEEDED");
				}
				if (contentLength !== undefined && bytes > contentLength) {
					throw new ImageProcessingError("IMAGE_PROCESSOR_SOURCE_SIZE_MISMATCH");
				}
				controller.enqueue(chunk);
			},
			flush() {
				assertInputBytes(bytes);
				if (contentLength !== undefined && bytes !== contentLength) {
					throw new ImageProcessingError("IMAGE_PROCESSOR_SOURCE_SIZE_MISMATCH");
				}
			},
		}),
	);
}

function watermarkBytes(part: keyof typeof GUEST_WATERMARK_PNG): ReadableStream<Uint8Array> {
	const encoded = GUEST_WATERMARK_PNG[part];
	const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}
