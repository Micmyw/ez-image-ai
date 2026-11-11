/** Existing raster processor contract. SVG/GIF are validated and rasterized separately. */
export type ImageContentType = "image/jpeg" | "image/png" | "image/webp";

export interface ImageDimensions {
	width: number;
	height: number;
}

export interface ImageSourceOptions {
	contentLength?: number;
}

export interface ImageWatermarkOptions extends ImageDimensions, ImageSourceOptions {
	contentType: ImageContentType;
}

/** Private image bytes cross this boundary; object keys and access policy stay in storage. */
export interface ImageProcessor {
	readonly key: string;
	/** SeeAPI 2.0 accepts a static, padded 1568px JPEG of the complete source image. */
	moderationJpeg?(
		source: ReadableStream<Uint8Array>,
		options: ImageSourceOptions & { sourceUrl?: string },
	): Promise<ReadableStream<Uint8Array>>;
	/** Bounded video reference normalization; preserves geometry, never transcodes video. */
	normalizePng?(
		source: ReadableStream<Uint8Array>,
		options: ImageSourceOptions,
	): Promise<ReadableStream<Uint8Array>>;
	validateDecoded?(
		source: ReadableStream<Uint8Array>,
		contentType: ImageContentType,
		options: ImageSourceOptions,
	): Promise<void>;
	inspect(
		source: ReadableStream<Uint8Array>,
		contentType: ImageContentType,
		options?: ImageSourceOptions,
	): Promise<ImageDimensions>;
	watermark(
		source: ReadableStream<Uint8Array>,
		options: ImageWatermarkOptions,
	): Promise<ReadableStream<Uint8Array>>;
}

export class ImageProcessingError extends Error {
	readonly stage = "TRANSFER" as const;
	readonly retryable = false as const;

	constructor(readonly code: string) {
		super(code);
		this.name = "ImageProcessingError";
	}
}
