export type CleanupReservationStatus = "EXPIRED" | "RELEASED";

interface DeleteStorageObjectPayload {
	assetId: string;
	objectKey: string;
	cleanupObjectKeys?: string[];
	uploadSessionId?: string;
	reservationStatus?: CleanupReservationStatus;
}

interface AbortMultipartObjectPayload extends DeleteStorageObjectPayload {
	multipartUploadId: string;
}

export interface StorageCleanupDependencies {
	isComplete(operationKey: string): Promise<boolean>;
	deleteObject(objectKey: string): Promise<void>;
	abortMultipartUpload(objectKey: string, uploadId: string): Promise<void>;
	complete(input: {
		operationKey: string;
		action: "MEDIA_OBJECT_DELETE_COMPLETED" | "MEDIA_MULTIPART_ABORT_COMPLETED";
		assetId: string;
		objectKey: string;
		cleanupObjectKeys?: string[];
		multipartUploadId?: string;
		uploadSessionId?: string;
		reservationStatus?: CleanupReservationStatus;
	}): Promise<void>;
}

export async function deleteStorageObject(
	payload: DeleteStorageObjectPayload,
	dependencies: StorageCleanupDependencies,
): Promise<void> {
	const operationKey = `media-object-delete:${payload.assetId}:${objectKeyFingerprint(payload.objectKey)}`;
	if (await dependencies.isComplete(operationKey)) return;
	await deleteCleanupObjects(payload, dependencies);
	await dependencies.complete({
		operationKey,
		action: "MEDIA_OBJECT_DELETE_COMPLETED",
		assetId: payload.assetId,
		objectKey: payload.objectKey,
		...(payload.cleanupObjectKeys?.length ? { cleanupObjectKeys: payload.cleanupObjectKeys } : {}),
		...(payload.uploadSessionId ? { uploadSessionId: payload.uploadSessionId } : {}),
		...(payload.reservationStatus ? { reservationStatus: payload.reservationStatus } : {}),
	});
}

function objectKeyFingerprint(objectKey: string): string {
	return createHash("sha256").update(objectKey).digest("base64url").slice(0, 16);
}

export async function abortMultipartObject(
	payload: AbortMultipartObjectPayload,
	dependencies: StorageCleanupDependencies,
): Promise<void> {
	const operationKey = `media-multipart-abort:${payload.multipartUploadId}`;
	if (await dependencies.isComplete(operationKey)) return;
	try {
		await dependencies.abortMultipartUpload(payload.objectKey, payload.multipartUploadId);
	} catch (error) {
		if (!isNoSuchUpload(error)) throw error;
	}
	await deleteCleanupObjects(payload, dependencies);
	await dependencies.complete({
		operationKey,
		action: "MEDIA_MULTIPART_ABORT_COMPLETED",
		assetId: payload.assetId,
		objectKey: payload.objectKey,
		...(payload.cleanupObjectKeys?.length ? { cleanupObjectKeys: payload.cleanupObjectKeys } : {}),
		multipartUploadId: payload.multipartUploadId,
		...(payload.uploadSessionId ? { uploadSessionId: payload.uploadSessionId } : {}),
		...(payload.reservationStatus ? { reservationStatus: payload.reservationStatus } : {}),
	});
}

async function deleteCleanupObjects(
	payload: DeleteStorageObjectPayload,
	dependencies: StorageCleanupDependencies,
): Promise<void> {
	for (const objectKey of uniqueObjectKeys(payload)) {
		await dependencies.deleteObject(objectKey);
	}
}

function uniqueObjectKeys(payload: DeleteStorageObjectPayload): string[] {
	return [...new Set([payload.objectKey, ...(payload.cleanupObjectKeys ?? [])])];
}

function isNoSuchUpload(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "name" in error && error.name === "NoSuchUpload",
	);
}
import { createHash } from "node:crypto";
