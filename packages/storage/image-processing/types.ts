import type { MediaContentType } from "../types";

export type ImageContentType = Extract<MediaContentType, `image/${string}`>;

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
