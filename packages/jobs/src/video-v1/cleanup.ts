import { db } from "@repo/database/client";
import {
	claimVideoResourceCleanup,
	completeVideoResourceCleanup,
	listVideoResourceCleanupCandidates,
	listVideoStagingCleanup,
	completeVideoStagingCleanup,
} from "@repo/database/video-v1-cleanup";
import { abortMultipartUpload, deleteObject, listMultipartUploads } from "@repo/storage";

/** Direct video housekeeping; never dispatches the legacy executor or advances paid generation. */
export async function recoverVideoResources(limit = 20) {
	const now = new Date();
	const result = { scanned: 0, cleaned: 0, failed: 0 };
	const staging = await listVideoStagingCleanup({ limit, now }, db);
	for (const item of staging) {
		result.scanned++;
		try {
			if (item.stagingKey) await deleteObject({ bucket: "media", key: item.stagingKey });
			if (item.sourceKey) await deleteObject({ bucket: "media", key: item.sourceKey });
			await completeVideoStagingCleanup(item, db);
			result.cleaned++;
		} catch {
			result.failed++;
		}
	}
	const candidates = await listVideoResourceCleanupCandidates({ limit, now }, db);
	for (const candidate of candidates) {
		result.scanned++;
		try {
			const claim = await claimVideoResourceCleanup(candidate.id, now, db);
			if (!claim) continue;
			for (const multipart of claim.multipart)
				await abortMultipartUpload({
					bucket: "media",
					key: multipart.objectKey,
					uploadId: multipart.uploadId,
				});
			for (const key of claim.objectKeys) {
				for (const uploadId of await listMultipartUploads({ bucket: "media", key }))
					await abortMultipartUpload({ bucket: "media", key, uploadId });
				await deleteObject({ bucket: "media", key });
			}
			await completeVideoResourceCleanup(claim, now, db);
			result.cleaned++;
		} catch {
			result.failed++;
		}
	}
	return result;
}
