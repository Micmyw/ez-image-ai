import { createHash } from "node:crypto";

import type { Prisma } from "../../generated/client";

export async function queueGuestAssetCleanup(
	asset: Prisma.MediaAssetGetPayload<{ include: { uploadSessions: true } }>,
	now: Date,
	tx: Prisma.TransactionClient,
): Promise<number> {
	const uploadSession = asset.uploadSessions[0];
	const stagingObjectKey = uploadSession?.stagingObjectKey ?? asset.outputStagingObjectKey;
	let cleanupEvents = 0;

	cleanupEvents += await queueGuestCleanupEvent(
		{
			eventType: "MEDIA_OBJECT_DELETE",
			dedupeKey: guestObjectCleanupDedupeKey(asset.id, "delete", asset.objectKey),
			payload: {
				assetId: asset.id,
				objectKey: asset.objectKey,
				...(uploadSession
					? { uploadSessionId: uploadSession.id, reservationStatus: "RELEASED" }
					: asset.kind === "OUTPUT"
						? { storageReservationReferenceKey: `generation-output:${asset.id}` }
						: { storageReservationReferenceKey: `media-draft:${asset.id}` }),
			},
		},
		asset.id,
		now,
		tx,
	);

	if (stagingObjectKey) {
		const multipartUploadId = uploadSession?.multipartUploadId;
		cleanupEvents += await queueGuestCleanupEvent(
			{
				eventType: multipartUploadId ? "MEDIA_MULTIPART_ABORT" : "MEDIA_OBJECT_DELETE",
				dedupeKey: guestObjectCleanupDedupeKey(
					asset.id,
					multipartUploadId ? `multipart-${multipartUploadId}` : "delete",
					stagingObjectKey,
				),
				payload: {
					assetId: asset.id,
					objectKey: stagingObjectKey,
					...(multipartUploadId ? { multipartUploadId } : {}),
				},
			},
			asset.id,
			now,
			tx,
		);
	}

	const promotionMultipartUploadId =
		uploadSession?.promotionMultipartUploadId ?? asset.outputPromotionMultipartUploadId;
	if (promotionMultipartUploadId) {
		cleanupEvents += await queueGuestCleanupEvent(
			{
				eventType: "MEDIA_UPLOAD_CLEANUP",
				dedupeKey: guestObjectCleanupDedupeKey(
					asset.id,
					`promotion-${promotionMultipartUploadId}`,
					asset.objectKey,
				),
				payload: {
					assetId: asset.id,
					objectKey: asset.objectKey,
					multipartUploadId: promotionMultipartUploadId,
					promotionAbortOnly: true,
				},
			},
			asset.id,
			now,
			tx,
		);
	}

	return cleanupEvents;
}

async function queueGuestCleanupEvent(
	event: { eventType: string; dedupeKey: string; payload: Prisma.InputJsonValue },
	assetId: string,
	now: Date,
	tx: Prisma.TransactionClient,
): Promise<number> {
	const result = await tx.outboxEvent.createMany({
		data: [
			{
				eventType: event.eventType,
				aggregateType: "MEDIA_ASSET",
				aggregateId: assetId,
				dedupeKey: event.dedupeKey,
				payload: event.payload,
				availableAt: now,
			},
		],
		skipDuplicates: true,
	});
	return result.count;
}

function guestObjectCleanupDedupeKey(assetId: string, action: string, objectKey: string): string {
	return `guest-retention-${action}:${assetId}:${guestCleanupObjectFingerprint(objectKey)}`;
}

function guestCleanupObjectFingerprint(objectKey: string): string {
	return createHash("sha256").update(objectKey).digest("base64url").slice(0, 16);
}
