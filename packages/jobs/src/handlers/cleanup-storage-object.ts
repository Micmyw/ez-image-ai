interface DeleteStorageObjectPayload {
	assetId: string;
	objectKey: string;
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
		multipartUploadId?: string;
	}): Promise<void>;
}

export async function deleteStorageObject(
	payload: DeleteStorageObjectPayload,
	dependencies: StorageCleanupDependencies,
): Promise<void> {
	const operationKey = `media-object-delete:${payload.assetId}`;
	if (await dependencies.isComplete(operationKey)) return;
	await dependencies.deleteObject(payload.objectKey);
	await dependencies.complete({
		operationKey,
		action: "MEDIA_OBJECT_DELETE_COMPLETED",
		assetId: payload.assetId,
		objectKey: payload.objectKey,
	});
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
	await dependencies.complete({
		operationKey,
		action: "MEDIA_MULTIPART_ABORT_COMPLETED",
		assetId: payload.assetId,
		objectKey: payload.objectKey,
		multipartUploadId: payload.multipartUploadId,
	});
}

function isNoSuchUpload(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "name" in error && error.name === "NoSuchUpload",
	);
}
