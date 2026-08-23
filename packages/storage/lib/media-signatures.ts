import type { MediaContentType } from "../types";

export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 500 * 1024 * 1024;

export type MediaKind = "image" | "video";

export type MediaValidationErrorCode =
	| "OUTPUT_INLINE_BASE64_INVALID"
	| "OUTPUT_MEDIA_KIND_MISMATCH"
	| "OUTPUT_MEDIA_SIZE_EXCEEDED"
	| "OUTPUT_MEDIA_TYPE_MISMATCH"
	| "OUTPUT_MEDIA_TYPE_UNSUPPORTED";

/**
 * An untrusted provider result failed a deterministic content validation. The
 * finalizer may safely settle this job; retrying the same candidate cannot
 * make its bytes valid.
 */
export class MediaValidationError extends Error {
	readonly stage = "TRANSFER" as const;
	readonly retryable = false as const;

	constructor(
		readonly code: MediaValidationErrorCode,
		message: string,
	) {
		super(message);
		this.name = "MediaValidationError";
	}
}

const ALLOWED_MEDIA_TYPES = new Set<MediaContentType>([
	"image/jpeg",
	"image/png",
	"image/webp",
	"video/mp4",
	"video/webm",
	"video/quicktime",
]);

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
	return signature.every((byte, index) => bytes[index] === byte);
}

export function detectMediaType(bytes: Uint8Array): MediaContentType | null {
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (
		startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
		String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
	)
		return "image/webp";
	if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
	if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") {
		const brand = String.fromCharCode(...bytes.slice(8, 12));
		return brand === "qt  " ? "video/quicktime" : "video/mp4";
	}
	return null;
}

export function mediaKindForType(contentType: MediaContentType): MediaKind {
	return contentType.startsWith("image/") ? "image" : "video";
}

export function assertMediaKind(contentType: MediaContentType, expectedKind: MediaKind): void {
	if (mediaKindForType(contentType) !== expectedKind) {
		throw new MediaValidationError(
			"OUTPUT_MEDIA_KIND_MISMATCH",
			"Provider output media kind does not match the generation product",
		);
	}
}

export function assertDetectedMediaType(
	header: Uint8Array,
	expectedContentType?: MediaContentType,
): MediaContentType {
	const detected = detectMediaType(header);
	if (!detected) {
		throw new MediaValidationError(
			"OUTPUT_MEDIA_TYPE_UNSUPPORTED",
			"Provider output has an unsupported media signature",
		);
	}
	if (expectedContentType && detected !== expectedContentType) {
		throw new MediaValidationError(
			"OUTPUT_MEDIA_TYPE_MISMATCH",
			"Provider output signature does not match its declared media type",
		);
	}
	return detected;
}

export function getMediaByteLimit(contentType: MediaContentType): number {
	return contentType.startsWith("image/") ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
}

export function getMediaKindByteLimit(mediaKind: MediaKind): number {
	return mediaKind === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
}

export function validateMediaUpload(
	declaredType: string,
	header: Uint8Array,
	byteSize: number,
): asserts declaredType is MediaContentType {
	if (!ALLOWED_MEDIA_TYPES.has(declaredType as MediaContentType)) {
		throw new MediaValidationError(
			"OUTPUT_MEDIA_TYPE_UNSUPPORTED",
			"Media content type is not allowed",
		);
	}
	if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
		throw new MediaValidationError("OUTPUT_INLINE_BASE64_INVALID", "Media byte size is invalid");
	}
	const contentType = declaredType as MediaContentType;
	if (byteSize > getMediaByteLimit(contentType)) {
		throw new MediaValidationError("OUTPUT_MEDIA_SIZE_EXCEEDED", "Media byte limit exceeded");
	}
	assertDetectedMediaType(header, contentType);
}

/**
 * Decodes an inline provider result only after verifying its bytes. Provider
 * MIME metadata is advisory: the detected signature determines the result.
 */
export function decodeInlineBase64MediaOutput(input: { mimeType: string; data: string }): {
	contentType: MediaContentType;
	body: Buffer;
} {
	if (!isStrictBase64(input.data)) {
		throw new MediaValidationError(
			"OUTPUT_INLINE_BASE64_INVALID",
			"Inline provider output is not valid base64",
		);
	}
	const body = Buffer.from(input.data, "base64");
	if (body.byteLength === 0) {
		throw new MediaValidationError(
			"OUTPUT_INLINE_BASE64_INVALID",
			"Inline provider output is empty",
		);
	}
	const contentType = assertDetectedMediaType(
		body.subarray(0, 64),
		ALLOWED_MEDIA_TYPES.has(input.mimeType as MediaContentType)
			? (input.mimeType as MediaContentType)
			: undefined,
	);
	if (!ALLOWED_MEDIA_TYPES.has(input.mimeType as MediaContentType)) {
		throw new MediaValidationError(
			"OUTPUT_MEDIA_TYPE_MISMATCH",
			"Provider output MIME metadata is not an allowed media type",
		);
	}
	if (body.byteLength > getMediaByteLimit(contentType)) {
		throw new MediaValidationError(
			"OUTPUT_MEDIA_SIZE_EXCEEDED",
			"Inline provider output exceeds the media byte limit",
		);
	}
	return { contentType, body };
}

export function decodeInlineBase64Image(value: string): {
	contentType: Extract<MediaContentType, `image/${string}`>;
	body: Buffer;
} {
	const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
	if (!match) {
		throw new MediaValidationError(
			"OUTPUT_INLINE_BASE64_INVALID",
			"Inline provider output must be a supported base64 image",
		);
	}
	const decoded = decodeInlineBase64MediaOutput({ mimeType: match[1]!, data: match[2]! });
	assertMediaKind(decoded.contentType, "image");
	return {
		contentType: decoded.contentType as Extract<MediaContentType, `image/${string}`>,
		body: decoded.body,
	};
}

function isStrictBase64(value: string): boolean {
	return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}
