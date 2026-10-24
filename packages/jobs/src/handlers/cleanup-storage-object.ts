import { createHash } from "node:crypto";

import { ImageDeletionPausedError } from "../contracts";

export type CleanupReservationStatus = "EXPIRED" | "RELEASED";

interface DeleteStorageObjectPayload {
	assetId: string;
	objectKey: string;
	cleanupObjectKeys?: string[];
	uploadSessionId?: string;
	reservationStatus?: CleanupReservationStatus;
	storageReservationReferenceKey?: string;
}

interface AbortMultipartObjectPayload extends DeleteStorageObjectPayload {
	multipartUploadId: string;
}

interface CleanupUploadPromotionPayload extends DeleteStorageObjectPayload {
	multipartUploadId?: string;
	promotionObjectKey: string;
	promotionMultipartUploadId?: string;
}

interface AbortPromotionMultipartPayload {
	assetId: string;
	objectKey: string;
	multipartUploadId: string;
}

export interface StorageCleanupDependencies {
	/** Production consumers must authorize the complete key set before any storage operation. */
	claimDeletion(input: {
		assetId: string;
		objectKeys: string[];
		uploadSessionId?: string;
		releasesReservation: boolean;
	}): Promise<"DELETE" | "SKIP" | { outcome: "DEFER"; retainedObjectKey: string }>;
	isComplete(operationKey: string): Promise<boolean>;
	deleteObject(objectKey: string): Promise<void>;
	abortMultipartUpload(objectKey: string, uploadId: string): Promise<void>;
	listMultipartUploads?(objectKey: string): Promise<string[]>;
	complete(input: {
		operationKey: string;
		action:
			| "MEDIA_OBJECT_DELETE_COMPLETED"
			| "MEDIA_MULTIPART_ABORT_COMPLETED"
			| "MEDIA_UPLOAD_PROMOTION_CLEANUP_COMPLETED"
			| "MEDIA_PROMOTION_MULTIPART_ABORT_COMPLETED";
		assetId: string;
		objectKey: string;
		cleanupObjectKeys?: string[];
		deletedObjectKeys?: string[];
		multipartUploadId?: string;
		uploadSessionId?: string;
		reservationStatus?: CleanupReservationStatus;
		storageReservationReferenceKey?: string;
	}): Promise<void>;
}

export async function deleteStorageObject(
	payload: DeleteStorageObjectPayload,
	dependencies: StorageCleanupDependencies,
): Promise<void> {
	if (!(await claimDeletion(payload, dependencies))) return;
	const operationKey = cleanupOperationKey("media-object-delete", payload);
	if (await dependencies.isComplete(operationKey)) return;
	await deleteCleanupObjects(payload, dependencies);
	await dependencies.complete({
		operationKey,
		action: "MEDIA_OBJECT_DELETE_COMPLETED",
		deletedObjectKeys: uniqueObjectKeys(payload),
		assetId: payload.assetId,
		objectKey: payload.objectKey,
		...(payload.cleanupObjectKeys?.length ? { cleanupObjectKeys: payload.cleanupObjectKeys } : {}),
		...(payload.uploadSessionId ? { uploadSessionId: payload.uploadSessionId } : {}),
		...(payload.reservationStatus ? { reservationStatus: payload.reservationStatus } : {}),
		...(payload.storageReservationReferenceKey
			? { storageReservationReferenceKey: payload.storageReservationReferenceKey }
			: {}),
	});
}

function objectKeyFingerprint(objectKey: string): string {
	return createHash("sha256").update(objectKey).digest("base64url").slice(0, 16);
}

export async function abortMultipartObject(
	payload: AbortMultipartObjectPayload,
	dependencies: StorageCleanupDependencies,
): Promise<void> {
	if (!(await claimDeletion(payload, dependencies))) return;
	const operationKey = cleanupOperationKey("media-multipart-abort", payload);
	if (await dependencies.isComplete(operationKey)) return;
	await abortMultipartUpload(payload.objectKey, payload.multipartUploadId, dependencies);
	await deleteCleanupObjects(payload, dependencies);
	await dependencies.complete({
		operationKey,
		action: "MEDIA_MULTIPART_ABORT_COMPLETED",
		deletedObjectKeys: uniqueObjectKeys(payload),
		assetId: payload.assetId,
		objectKey: payload.objectKey,
		...(payload.cleanupObjectKeys?.length ? { cleanupObjectKeys: payload.cleanupObjectKeys } : {}),
		...(payload.multipartUploadId ? { multipartUploadId: payload.multipartUploadId } : {}),
		...(payload.uploadSessionId ? { uploadSessionId: payload.uploadSessionId } : {}),
		...(payload.reservationStatus ? { reservationStatus: payload.reservationStatus } : {}),
		...(payload.storageReservationReferenceKey
			? { storageReservationReferenceKey: payload.storageReservationReferenceKey }
			: {}),
	});
}

/**
 * Cleans a terminal upload session whose final immutable-object promotion may
 * have created a durable multipart upload. Physical cleanup precedes the
 * completion audit so a reservation cannot be released while any staging or
 * final object state remains.
 */
export async function cleanupUploadPromotion(
	payload: CleanupUploadPromotionPayload,
	dependencies: StorageCleanupDependencies,
): Promise<void> {
	if (!(await claimDeletion(payload, dependencies, payload.promotionObjectKey))) return;
	const operationKey = cleanupOperationKey(
		"media-upload-promotion-cleanup",
		payload,
		payload.promotionObjectKey,
	);
	if (await dependencies.isComplete(operationKey)) return;

	if (payload.multipartUploadId) {
		await abortMultipartUpload(payload.objectKey, payload.multipartUploadId, dependencies);
	}
	if (payload.promotionMultipartUploadId) {
		await abortMultipartUpload(
			payload.promotionObjectKey,
			payload.promotionMultipartUploadId,
			dependencies,
		);
	}
	await abortIncompletePromotionMultipartUploads(payload, dependencies);
	await deleteCleanupObjects(payload, dependencies, payload.promotionObjectKey);
	await dependencies.complete({
		operationKey,
		action: "MEDIA_UPLOAD_PROMOTION_CLEANUP_COMPLETED",
		deletedObjectKeys: uniqueObjectKeys(payload, payload.promotionObjectKey),
		assetId: payload.assetId,
		objectKey: payload.objectKey,
		...(payload.cleanupObjectKeys?.length ? { cleanupObjectKeys: payload.cleanupObjectKeys } : {}),
		multipartUploadId: payload.multipartUploadId,
		...(payload.uploadSessionId ? { uploadSessionId: payload.uploadSessionId } : {}),
		...(payload.reservationStatus ? { reservationStatus: payload.reservationStatus } : {}),
		...(payload.storageReservationReferenceKey
			? { storageReservationReferenceKey: payload.storageReservationReferenceKey }
			: {}),
	});
}

/**
 * Used while reclaiming an expired finalization lease. It intentionally never
 * deletes the final object key because another lease holder may still finish
 * from a verified immutable object after the stale multipart upload is gone.
 */
export async function abortPromotionMultipart(
	payload: AbortPromotionMultipartPayload,
	dependencies: StorageCleanupDependencies,
): Promise<void> {
	const operationKey = `media-promotion-multipart-abort:${payload.multipartUploadId}`;
	if (await dependencies.isComplete(operationKey)) return;
	await abortMultipartUpload(payload.objectKey, payload.multipartUploadId, dependencies);
	await dependencies.complete({
		operationKey,
		action: "MEDIA_PROMOTION_MULTIPART_ABORT_COMPLETED",
		assetId: payload.assetId,
		objectKey: payload.objectKey,
		multipartUploadId: payload.multipartUploadId,
	});
}

async function deleteCleanupObjects(
	payload: DeleteStorageObjectPayload,
	dependencies: StorageCleanupDependencies,
	extraObjectKey?: string,
): Promise<void> {
	for (const objectKey of uniqueObjectKeys(payload, extraObjectKey)) {
		await dependencies.deleteObject(objectKey);
	}
}

function uniqueObjectKeys(payload: DeleteStorageObjectPayload, extraObjectKey?: string): string[] {
	return [
		...new Set([
			payload.objectKey,
			...(payload.cleanupObjectKeys ?? []),
			...(extraObjectKey ? [extraObjectKey] : []),
		]),
	];
}

/** Old receipts remain immutable. A v2 receipt proves the whole deletion group
 * and its explicit capacity-release semantics, rather than only the primary key.
 */
function cleanupOperationKey(
	action: string,
	payload: DeleteStorageObjectPayload & {
		multipartUploadId?: string;
		promotionMultipartUploadId?: string;
	},
	extraObjectKey?: string,
): string {
	return `${action}:v2:${payload.assetId}:${objectKeyFingerprint(
		JSON.stringify({
			objectKey: payload.objectKey,
			promotionObjectKey: extraObjectKey,
			objectKeys: uniqueObjectKeys(payload, extraObjectKey).sort(),
			multipartUploadId: payload.multipartUploadId,
			promotionMultipartUploadId: payload.promotionMultipartUploadId,
			uploadSessionId: payload.uploadSessionId,
			reservationStatus: payload.reservationStatus,
			storageReservationReferenceKey: payload.storageReservationReferenceKey,
		}),
	)}`;
}

async function claimDeletion(
	payload: DeleteStorageObjectPayload & {
		multipartUploadId?: string;
		promotionMultipartUploadId?: string;
	},
	dependencies: StorageCleanupDependencies,
	extraObjectKey?: string,
): Promise<boolean> {
	const decision = await dependencies.claimDeletion({
		assetId: payload.assetId,
		objectKeys: uniqueObjectKeys(payload, extraObjectKey),
		...(payload.uploadSessionId ? { uploadSessionId: payload.uploadSessionId } : {}),
		releasesReservation: Boolean(
			(payload.uploadSessionId && payload.reservationStatus) ||
			payload.storageReservationReferenceKey,
		),
	});
	if (typeof decision === "object" && decision.outcome === "DEFER") {
		// A complete original may exist after a lost finalization response. Keep
		// that exact key, but clean proven staging and incomplete multipart data.
		try {
			if (payload.multipartUploadId)
				await abortMultipartUpload(payload.objectKey, payload.multipartUploadId, dependencies);
			if (extraObjectKey && payload.promotionMultipartUploadId)
				await abortMultipartUpload(
					extraObjectKey,
					payload.promotionMultipartUploadId,
					dependencies,
				);
			if (extraObjectKey)
				await abortIncompletePromotionMultipartUploads(
					{ ...payload, promotionObjectKey: extraObjectKey },
					dependencies,
				);
			for (const objectKey of uniqueObjectKeys(payload, extraObjectKey))
				if (objectKey !== decision.retainedObjectKey) await dependencies.deleteObject(objectKey);
		} catch (error) {
			// Preserve the original deletion intent and quota even if ancillary
			// cleanup fails. The same deferred event retries those idempotent writes.
			throw new ImageDeletionPausedError(error);
		}
		throw new ImageDeletionPausedError();
	}
	return decision !== "SKIP";
}

async function abortIncompletePromotionMultipartUploads(
	payload: CleanupUploadPromotionPayload,
	dependencies: StorageCleanupDependencies,
): Promise<void> {
	if (!dependencies.listMultipartUploads) {
		throw new Error("Storage cleanup requires exact-key multipart listing");
	}
	const uploadIds = await dependencies.listMultipartUploads(payload.promotionObjectKey);
	for (const uploadId of new Set(uploadIds)) {
		if (uploadId === payload.promotionMultipartUploadId) continue;
		await abortMultipartUpload(payload.promotionObjectKey, uploadId, dependencies);
	}
}

async function abortMultipartUpload(
	objectKey: string,
	uploadId: string,
	dependencies: StorageCleanupDependencies,
): Promise<void> {
	try {
		await dependencies.abortMultipartUpload(objectKey, uploadId);
	} catch (error) {
		if (!isNoSuchUpload(error)) throw error;
	}
}

function isNoSuchUpload(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "name" in error && error.name === "NoSuchUpload",
	);
}
