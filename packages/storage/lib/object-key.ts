import type { MediaContentType, MediaDerivativeKind } from "../types";

const EXTENSIONS: Record<MediaContentType, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"video/mp4": "mp4",
	"video/webm": "webm",
	"video/quicktime": "mov",
};

const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]+$/;

export function createAssetObjectKey(
	ownerId: string,
	assetId: string,
	contentType: MediaContentType,
	derivative: MediaDerivativeKind = "original",
): string {
	if (![ownerId, assetId, derivative].every((value) => SAFE_IDENTIFIER.test(value))) {
		throw new Error("Storage object identifier is invalid");
	}
	return `users/${ownerId}/assets/${assetId}/${derivative}.${EXTENSIONS[contentType]}`;
}

export function createFinalAssetObjectKey(
	ownerId: string,
	assetId: string,
	versionId: string,
	contentType: MediaContentType,
): string {
	if (![ownerId, assetId, versionId].every((value) => SAFE_IDENTIFIER.test(value))) {
		throw new Error("Storage object identifier is invalid");
	}
	return `users/${ownerId}/assets/${assetId}/versions/${versionId}/original.${EXTENSIONS[contentType]}`;
}

export function createStagingObjectKey(
	ownerId: string,
	sessionId: string,
	nonce: string,
	contentType: MediaContentType,
): string {
	if (![ownerId, sessionId, nonce].every((value) => SAFE_IDENTIFIER.test(value))) {
		throw new Error("Storage object identifier is invalid");
	}
	return `users/${ownerId}/staging/${sessionId}/${nonce}.${EXTENSIONS[contentType]}`;
}
