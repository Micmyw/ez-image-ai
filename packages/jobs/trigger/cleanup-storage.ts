import { task } from "@trigger.dev/sdk";

import { abortMultipartObject, deleteStorageObject } from "../src/handlers/cleanup-storage-object";
import { databaseStorageCleanupDependencies } from "../src/runtime";

export const deleteObjectTask = task({
	id: "media-delete-object",
	queue: { name: "media-storage-cleanup", concurrencyLimit: 4 },
	maxDuration: 120,
	run: (payload: { assetId: string; objectKey: string }) =>
		deleteStorageObject(payload, databaseStorageCleanupDependencies),
});

export const abortMultipartTask = task({
	id: "media-abort-multipart",
	queue: { name: "media-storage-cleanup", concurrencyLimit: 4 },
	maxDuration: 120,
	run: (payload: { assetId: string; objectKey: string; multipartUploadId: string }) =>
		abortMultipartObject(payload, databaseStorageCleanupDependencies),
});
