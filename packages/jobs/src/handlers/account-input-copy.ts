import type {
	AccountInputCopyClaim,
	AccountInputCopyDependencies,
	AccountInputCopyOrphanDependencies,
	AccountInputCopyPayload,
	AccountInputCopyRecoveryDependencies,
} from "../contracts";

/** Database methods each finish before storage I/O starts. Only their current token can commit. */
export async function copyAccountInput(
	payload: AccountInputCopyPayload,
	dependencies: AccountInputCopyDependencies,
): Promise<{ outcome: "SKIPPED" | "VERIFYING" | "FAILED" }> {
	const claim = await dependencies.claim(payload);
	if (!claim) return { outcome: "SKIPPED" };
	if (!validCopyIdentity(claim, payload)) {
		await dependencies.fail({
			...payload,
			leaseToken: claim.leaseToken,
			reasonCode: "ACCOUNT_INPUT_COPY_IDENTITY_INVALID",
			definitive: true,
		});
		return { outcome: "FAILED" };
	}
	let copied: Awaited<ReturnType<AccountInputCopyDependencies["copy"]>>;
	try {
		copied = await copyWithMultipartRecovery(claim, dependencies);
		if (copied.bytes !== claim.source.bytes || copied.sha256 !== claim.source.checksum)
			throw Object.assign(new Error("ACCOUNT_INPUT_COPY_CONTENT_INVALID"), {
				code: "ACCOUNT_INPUT_COPY_CONTENT_INVALID",
			});
	} catch (error) {
		const definitive = isInvalidContent(error);
		if (definitive) {
			// This helper irreversibly tombstones the destination before queuing cleanup.
			await dependencies.fail({
				...payload,
				leaseToken: claim.leaseToken,
				reasonCode: "ACCOUNT_INPUT_COPY_CONTENT_INVALID",
				definitive: true,
			});
			return { outcome: "FAILED" };
		}
		await retainForRetry(dependencies, claim, "ACCOUNT_INPUT_COPY_RETRYABLE");
		throw error;
	}
	try {
		await dependencies.commit({
			...payload,
			leaseToken: claim.leaseToken,
			checksum: copied.sha256,
			bytes: copied.bytes,
			mimeType: claim.source.mimeType,
			storageEtag: copied.etag ?? undefined,
			storageVersionId: copied.versionId ?? undefined,
		});
	} catch (error) {
		// A lost DB response may already have materialized VERIFYING media. Never delete it.
		await retainForRetry(dependencies, claim, "ACCOUNT_INPUT_COPY_COMMIT_RETRYABLE");
		throw error;
	}
	return { outcome: "VERIFYING" };
}

async function copyWithMultipartRecovery(
	claim: AccountInputCopyClaim,
	dependencies: AccountInputCopyDependencies,
) {
	let multipartUploadId = claim.multipartUploadId;
	let recoveredMissingUpload = false;
	for (;;) {
		try {
			return await dependencies.copy({
				staging: { bucket: "media", key: claim.source.objectKey },
				final: { bucket: "media", key: claim.target.objectKey },
				contentType: claim.source.mimeType,
				contentLength: claim.source.bytes,
				expectedSha256: claim.source.checksum,
				acceptExistingFinalIdentity: false,
				// Preserve the default streaming multipart path and full destination GET.
				promotion: {
					...(multipartUploadId ? { uploadId: multipartUploadId } : {}),
					onMultipartUploadCreated: async ({ uploadId }) => {
						await dependencies.registerMultipart({
							promotionId: claim.promotionId,
							leaseToken: claim.leaseToken,
							multipartUploadId: uploadId,
						});
						multipartUploadId = uploadId;
					},
				},
			});
		} catch (error) {
			if (
				!multipartUploadId ||
				recoveredMissingUpload ||
				!error ||
				typeof error !== "object" ||
				!("name" in error) ||
				error.name !== "NoSuchUpload"
			)
				throw error;
			// Never list/abort a live destination. Clear only the missing exact upload
			// ID through the current business token, then retry this immutable key once.
			await dependencies.clearMultipart({
				promotionId: claim.promotionId,
				leaseToken: claim.leaseToken,
				multipartUploadId,
			});
			multipartUploadId = undefined;
			recoveredMissingUpload = true;
		}
	}
}

export async function cleanupAccountInputCopyOrphan(
	payload: AccountInputCopyPayload,
	dependencies: AccountInputCopyOrphanDependencies,
): Promise<{ outcome: "SKIPPED" | "CHECKED" }> {
	const orphan = await dependencies.claim(payload);
	if (!orphan) return { outcome: "SKIPPED" };
	const location = { bucket: "media" as const, key: orphan.objectKey };
	// The DB claim proves this exact destination was irreversibly abandoned. Its
	// key can never be reused, so aborting its late writer cannot affect a live copy.
	const uploadIds = new Set([
		...(orphan.multipartUploadId ? [orphan.multipartUploadId] : []),
		...(await dependencies.listMultipartUploads(location)),
	]);
	for (const uploadId of uploadIds) {
		try {
			await dependencies.abortMultipartUpload({ ...location, uploadId });
		} catch (error) {
			if (!isStorageMissing(error, "NoSuchUpload")) throw error;
		}
	}
	try {
		await dependencies.deleteObject(location);
	} catch (error) {
		if (!isStorageMissing(error, "NoSuchKey")) throw error;
	}
	// This pass alone cannot close unknown late I/O. The DB helper owns capacity
	// decisions from durable evidence, and keeps uncertain writers recoverable.
	await dependencies.recordPass(payload);
	return { outcome: "CHECKED" };
}

export async function recoverAccountInputCopyTasks(
	input: { timestamp: number; limit?: number },
	dependencies: AccountInputCopyRecoveryDependencies,
): Promise<{ copies: number; orphans: number }> {
	const recovered = await dependencies.recover({ limit: input.limit ?? 20 });
	for (const [taskId, ids] of [
		["media-copy-account-input", recovered.promotionIds],
		["media-cleanup-account-input-copy", recovered.orphanIds],
	] as const) {
		for (const promotionId of ids)
			await dependencies.dispatch(
				taskId,
				{ promotionId },
				{
					idempotencyKey: `${taskId}:recovery:${promotionId}:${input.timestamp}`,
				},
			);
	}
	return { copies: recovered.promotionIds.length, orphans: recovered.orphanIds.length };
}

function validCopyIdentity(
	claim: AccountInputCopyClaim,
	payload: AccountInputCopyPayload,
): boolean {
	return (
		claim.promotionId === payload.promotionId &&
		Boolean(claim.leaseToken) &&
		claim.source.assetId !== claim.target.assetId &&
		claim.source.objectKey !== claim.target.objectKey &&
		/^[a-f0-9]{64}$/.test(claim.source.checksum) &&
		Number.isSafeInteger(claim.source.bytes) &&
		claim.source.bytes > 0 &&
		["image/jpeg", "image/png", "image/webp"].includes(claim.source.mimeType) &&
		claim.target.objectKey.startsWith(
			`users/${claim.target.ownerId}/assets/${claim.target.assetId}/`,
		)
	);
}

function isInvalidContent(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const value = error as { name?: unknown; code?: unknown; message?: unknown };
	return (
		value.code === "ACCOUNT_INPUT_COPY_CONTENT_INVALID" ||
		value.message === "UPLOAD_CHECKSUM_MISMATCH" ||
		(value.name === "MediaValidationError" &&
			[
				"OUTPUT_MEDIA_SIZE_EXCEEDED",
				"OUTPUT_MEDIA_TYPE_MISMATCH",
				"OUTPUT_MEDIA_TYPE_UNSUPPORTED",
			].includes(String(value.code)))
	);
}

async function retainForRetry(
	dependencies: AccountInputCopyDependencies,
	claim: AccountInputCopyClaim,
	reasonCode: string,
): Promise<void> {
	try {
		await dependencies.fail({
			promotionId: claim.promotionId,
			leaseToken: claim.leaseToken,
			reasonCode,
			definitive: false,
		});
	} catch {
		// Preserve the original uncertain I/O/commit failure. Durable recovery owns the lease.
	}
}

function isStorageMissing(error: unknown, name: "NoSuchUpload" | "NoSuchKey"): boolean {
	if (!error || typeof error !== "object") return false;
	const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
	return value.name === name || value.$metadata?.httpStatusCode === 404;
}
