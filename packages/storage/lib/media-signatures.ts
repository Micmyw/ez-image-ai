import type { MediaContentType } from "../types";

export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 500 * 1024 * 1024;

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

export function getMediaByteLimit(contentType: MediaContentType): number {
	return contentType.startsWith("image/") ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
}

export function validateMediaUpload(
	declaredType: string,
	header: Uint8Array,
	byteSize: number,
): asserts declaredType is MediaContentType {
	if (!ALLOWED_MEDIA_TYPES.has(declaredType as MediaContentType)) {
		throw new Error("Media content type is not allowed");
	}
	if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
		throw new Error("Media byte size is invalid");
	}
	const contentType = declaredType as MediaContentType;
	if (byteSize > getMediaByteLimit(contentType)) {
		throw new Error("Media byte limit exceeded");
	}
	if (detectMediaType(header) !== contentType) {
		throw new Error("Media signature does not match its declared content type");
	}
}

export function decodeInlineBase64Image(value: string): {
	contentType: Extract<MediaContentType, `image/${string}`>;
	body: Buffer;
} {
	const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
	if (!match) throw new Error("Inline provider output must be a supported base64 image");
	const body = Buffer.from(match[2]!, "base64");
	validateMediaUpload(match[1]!, body.subarray(0, 32), body.byteLength);
	return { contentType: match[1] as Extract<MediaContentType, `image/${string}`>, body };
}
