import {
	detectMediaType,
	getMediaByteLimit,
	type MediaContentType,
	type MediaObjectMetadata,
} from "@repo/storage";

const SINGLE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export interface ParsedUploadRequest {
	contentType: MediaContentType;
	byteSize: number;
	multipart: boolean;
}

export function parseUploadRequest(input: {
	contentType: string;
	byteSize: number;
}): ParsedUploadRequest {
	const allowed = new Set<MediaContentType>([
		"image/jpeg",
		"image/png",
		"image/webp",
		"video/mp4",
		"video/webm",
		"video/quicktime",
	]);
	if (!allowed.has(input.contentType as MediaContentType))
		throw new Error("Media type is not allowed");
	const contentType = input.contentType as MediaContentType;
	if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0)
		throw new Error("Media size is invalid");
	if (input.byteSize > getMediaByteLimit(contentType)) throw new Error("Media size limit exceeded");
	return {
		contentType,
		byteSize: input.byteSize,
		multipart: input.byteSize > SINGLE_UPLOAD_MAX_BYTES,
	};
}

export function assertCompletedObjectMatchesSession(input: {
	expectedContentType: MediaContentType;
	expectedBytes: number;
	head: MediaObjectMetadata;
	header: Uint8Array;
}): void {
	if (input.head.contentLength !== input.expectedBytes)
		throw new Error("Uploaded object size does not match the session");
	if (input.head.contentType !== input.expectedContentType)
		throw new Error("Uploaded object content type does not match the session");
	if (detectMediaType(input.header) !== input.expectedContentType)
		throw new Error("Uploaded object signature does not match the session");
}

export interface MediaAssetDto {
	id: string;
	status: string;
	mimeType: string;
	byteSize: string;
}

export function toMediaAssetDto(asset: {
	id: string;
	status: string;
	mimeType: string;
	byteSize: bigint;
	objectKey?: string;
}): MediaAssetDto {
	return {
		id: asset.id,
		status: asset.status,
		mimeType: asset.mimeType,
		byteSize: asset.byteSize.toString(),
	};
}
