import { task } from "@trigger.dev/sdk";

import {
	abortMultipartObject,
	abortPromotionMultipart,
	cleanupUploadPromotion,
	deleteStorageObject,
} from "../src/handlers/cleanup-storage-object";
import { databaseStorageCleanupDependencies } from "../src/runtime";

export const deleteObjectTask = task({
	id: "media-delete-object",
	queue: { name: "media-storage-cleanup", concurrencyLimit: 4 },
	maxDuration: 120,
	run: (payload: {
		assetId: string;
		objectKey: string;
		cleanupObjectKeys?: string[];
		uploadSessionId?: string;
		reservationStatus?: "EXPIRED" | "RELEASED";
		storageReservationReferenceKey?: string;
	}) => deleteStorageObject(payload, databaseStorageCleanupDependencies),
});

export const abortMultipartTask = task({
	id: "media-abort-multipart",
	queue: { name: "media-storage-cleanup", concurrencyLimit: 4 },
	maxDuration: 120,
	run: (payload: {
		assetId: string;
		objectKey: string;
		cleanupObjectKeys?: string[];
		multipartUploadId: string;
		uploadSessionId?: string;
		reservationStatus?: "EXPIRED" | "RELEASED";
		storageReservationReferenceKey?: string;
	}) => abortMultipartObject(payload, databaseStorageCleanupDependencies),
});

export const cleanupUploadPromotionTask = task({
	id: "media-cleanup-upload-promotion",
	queue: { name: "media-storage-cleanup", concurrencyLimit: 4 },
	maxDuration: 120,
	run: (payload: {
		assetId: string;
		objectKey: string;
		multipartUploadId?: string;
		promotionObjectKey: string;
		promotionMultipartUploadId?: string;
		cleanupObjectKeys?: string[];
		uploadSessionId?: string;
		reservationStatus?: "EXPIRED" | "RELEASED";
		storageReservationReferenceKey?: string;
	}) => cleanupUploadPromotion(payload, databaseStorageCleanupDependencies),
});

export const abortPromotionMultipartTask = task({
	id: "media-abort-promotion-multipart",
	queue: { name: "media-storage-cleanup", concurrencyLimit: 4 },
	maxDuration: 120,
	run: (payload: { assetId: string; objectKey: string; multipartUploadId: string }) =>
		abortPromotionMultipart(payload, databaseStorageCleanupDependencies),
});
