import {
	lockMediaAssetGenerationBindings,
	LIVE_GENERATION_JOB_STATUSES,
} from "./asset-binding-locks";
import { lockOwnerStorageUsage } from "./storage-usage-locks";
import { runSerializable, type MediaTransactionClient } from "./types";

const ENGINE = "video-workflow-v1";
const DAY = 86_400_000;
const WRITE_GRACE = 600_000;
const TERMINAL = ["READY", "FAILED", "REJECTED"];

export interface VideoResourceCleanup {
	assetId: string;
	objectKeys: string[];
	multipart: Array<{ objectKey: string; uploadId: string }>;
	sessionIds: string[];
}

/** Bounded engine-indexed orphan selection; execution and accounting are never advanced here. */
export async function listVideoResourceCleanupCandidates(
	input: { limit: number; now: Date },
	db: MediaTransactionClient,
) {
	return db.mediaAsset.findMany({
		where: {
			verificationEngine: ENGINE,
			videoCleanupCompletedAt: null,
			jobBindings: {
				none: {
					job: {
						OR: [
							{ status: { in: [...LIVE_GENERATION_JOB_STATUSES] } },
							{ videoExecution: { stage: { notIn: ["READY", "FAILED", "REJECTED"] } } },
							{
								attempts: {
									some: {
										OR: [
											{ uncertainSubmission: true },
											{ status: { in: ["SUBMISSION_UNCERTAIN", "NEEDS_RECONCILIATION"] } },
										],
									},
								},
							},
						],
					},
				},
			},
			OR: [
				{ deletedAt: { not: null } },
				{
					kind: "INPUT",
					jobBindings: { none: {} },
					OR: [
						{ deleteAfter: { lte: input.now } },
						{ createdAt: { lte: new Date(input.now.getTime() - DAY) } },
						{
							uploadSessions: {
								some: {
									status: { in: ["PENDING", "FINALIZING", "ABORTED", "EXPIRED"] },
									expiresAt: { lte: new Date(input.now.getTime() - WRITE_GRACE) },
								},
							},
						},
					],
				},
				{ kind: "OUTPUT", createdAt: { lte: new Date(input.now.getTime() - 30 * DAY) } },
			],
		},
		select: { id: true },
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		take: Math.min(100, Math.max(1, input.limit)),
	});
}

/** Tombstone under the exact binding lock used by admission before any physical deletion. */
export async function claimVideoResourceCleanup(
	assetId: string,
	now: Date,
	db: MediaTransactionClient,
): Promise<VideoResourceCleanup | null> {
	const owner = await db.mediaAsset.findFirst({
		where: { id: assetId, verificationEngine: ENGINE },
		select: { ownerType: true, ownerId: true },
	});
	if (!owner) return null;
	return runSerializable(db, async (tx) => {
		await lockOwnerStorageUsage(owner, tx);
		await lockMediaAssetGenerationBindings([assetId], tx);
		const asset = await tx.mediaAsset.findFirst({
			where: { id: assetId, verificationEngine: ENGINE, videoCleanupCompletedAt: null },
			include: {
				uploadSessions: true,
				jobBindings: {
					include: {
						job: {
							include: {
								videoExecution: true,
								attempts: { select: { uncertainSubmission: true, status: true } },
							},
						},
					},
				},
			},
		});
		if (!asset) return null;
		if (
			asset.jobBindings.some(
				({ job }) =>
					(LIVE_GENERATION_JOB_STATUSES as readonly string[]).includes(job.status) ||
					(job.videoExecution && !TERMINAL.includes(job.videoExecution.stage)) ||
					job.attempts.some(
						(a) =>
							a.uncertainSubmission ||
							a.status === "NEEDS_RECONCILIATION" ||
							a.status === "SUBMISSION_UNCERTAIN",
					),
			)
		)
			return null;
		if (asset.outputTransferLeaseExpiresAt && asset.outputTransferLeaseExpiresAt > now) return null;
		if (asset.verificationLeasedUntil && asset.verificationLeasedUntil > now) return null;
		if (
			asset.uploadSessions.some(
				(s) =>
					(s.status === "PENDING" || s.status === "FINALIZING") &&
					(s.expiresAt.getTime() + WRITE_GRACE > now.getTime() ||
						(s.finalizationLeaseExpiresAt && s.finalizationLeaseExpiresAt > now)),
			)
		)
			return null;
		const expiredUpload = asset.uploadSessions.some(
			(s) => s.status !== "COMPLETED" && s.expiresAt.getTime() + WRITE_GRACE <= now.getTime(),
		);
		const due =
			asset.deletedAt ||
			(asset.kind === "INPUT" &&
				asset.jobBindings.length === 0 &&
				(expiredUpload ||
					(asset.deleteAfter && asset.deleteAfter <= now) ||
					asset.createdAt.getTime() + DAY <= now.getTime())) ||
			(asset.kind === "OUTPUT" && asset.createdAt.getTime() + 30 * DAY <= now.getTime());
		if (!due) return null;
		const originalKey = asset.objectKey.endsWith(".video-input.png")
			? asset.objectKey.slice(0, -".video-input.png".length)
			: asset.objectKey;
		const objectKeys = [
			...new Set(
				[
					asset.objectKey,
					originalKey,
					asset.outputStagingObjectKey,
					...asset.uploadSessions.map((s) => s.stagingObjectKey),
				].filter((key): key is string => Boolean(key)),
			),
		];
		const multipart: VideoResourceCleanup["multipart"] = [];
		if (asset.outputPromotionMultipartUploadId)
			multipart.push({
				objectKey: asset.objectKey,
				uploadId: asset.outputPromotionMultipartUploadId,
			});
		for (const session of asset.uploadSessions) {
			if (session.multipartUploadId && session.stagingObjectKey)
				multipart.push({
					objectKey: session.stagingObjectKey,
					uploadId: session.multipartUploadId,
				});
			if (session.promotionMultipartUploadId)
				multipart.push({ objectKey: originalKey, uploadId: session.promotionMultipartUploadId });
		}
		await tx.mediaAsset.update({
			where: { id: asset.id },
			data: { status: "DELETED", deletedAt: asset.deletedAt ?? now },
		});
		await tx.mediaUploadSession.updateMany({
			where: { assetId: asset.id, status: { in: ["PENDING", "FINALIZING"] } },
			data: { status: "EXPIRED", finalizationToken: null, finalizationLeaseExpiresAt: null },
		});
		return { assetId, objectKeys, multipart, sessionIds: asset.uploadSessions.map((s) => s.id) };
	});
}

/** Release bytes only after every physical object/multipart operation succeeded. */
export async function completeVideoResourceCleanup(
	claim: VideoResourceCleanup,
	now: Date,
	db: MediaTransactionClient,
) {
	return runSerializable(db, async (tx) => {
		const asset = await tx.mediaAsset.findFirst({
			where: {
				id: claim.assetId,
				verificationEngine: ENGINE,
				status: "DELETED",
				deletedAt: { not: null },
			},
		});
		if (!asset || asset.videoCleanupCompletedAt) return;
		await lockOwnerStorageUsage({ ownerType: asset.ownerType, ownerId: asset.ownerId }, tx);
		await tx.storageUsageReservation.updateMany({
			where: {
				referenceKey: {
					in: [
						`generation-output:${asset.id}`,
						`video-output:${asset.id}`,
						...claim.sessionIds.map((id) => `media-upload:${id}`),
					],
				},
				status: { in: ["ACTIVE", "COMMITTED"] },
			},
			data: { status: "RELEASED", releasedAt: now },
		});
		await tx.mediaAsset.update({
			where: { id: asset.id },
			data: {
				videoCleanupCompletedAt: now,
				outputTransferToken: null,
				outputTransferLeaseExpiresAt: null,
				outputPromotionMultipartUploadId: null,
				outputStagingObjectKey: null,
			},
		});
		await tx.auditLog.create({
			data: {
				action: "VIDEO_RESOURCE_CLEANUP_COMPLETED",
				targetType: "MEDIA_ASSET",
				targetId: asset.id,
				metadata: { objects: claim.objectKeys.length, multipart: claim.multipart.length },
			},
		});
	});
}

export async function listVideoStagingCleanup(
	input: { limit: number; now: Date },
	db: MediaTransactionClient,
) {
	const due = new Date(input.now.getTime() - WRITE_GRACE);
	const limit = Math.min(100, Math.max(1, input.limit));
	// Source cleanup is independent of staging cleanup: normalization can finish after staging was removed.
	return db.$queryRaw<
		Array<{
			sessionId: string;
			assetId: string;
			stagingKey: string | null;
			sourceKey: string | null;
		}>
	>`
  SELECT s."id" AS "sessionId", s."assetId", s."stagingObjectKey" AS "stagingKey",
   CASE WHEN a."objectKey" LIKE '%.video-input.png' AND r."bytes" > a."byteSize"
    THEN left(a."objectKey", length(a."objectKey")-length('.video-input.png')) ELSE NULL END AS "sourceKey"
  FROM "media_upload_session" s
  JOIN "media_asset" a ON a."id"=s."assetId"
  LEFT JOIN "storage_usage_reservation" r ON r."referenceKey"='media-upload:'||s."id" AND r."status"='COMMITTED'
  WHERE s."status"='COMPLETED' AND s."completedAt" <= ${due}
   AND a."verificationEngine"='video-workflow-v1' AND a."deletedAt" IS NULL
   AND (s."stagingObjectKey" IS NOT NULL OR (a."objectKey" LIKE '%.video-input.png' AND r."bytes" > a."byteSize"))
  ORDER BY s."completedAt", s."id" LIMIT ${limit}`;
}
export async function completeVideoStagingCleanup(
	input: { sessionId: string; stagingKey: string | null; sourceKey: string | null },
	db: MediaTransactionClient,
) {
	return runSerializable(db, async (tx) => {
		const session = await tx.mediaUploadSession.findFirst({
			where: {
				id: input.sessionId,
				status: "COMPLETED",
				stagingObjectKey: input.stagingKey,
				asset: { verificationEngine: ENGINE, deletedAt: null },
			},
			include: { asset: true },
		});
		if (!session) return;
		await lockOwnerStorageUsage(
			{ ownerType: session.asset.ownerType, ownerId: session.asset.ownerId },
			tx,
		);
		await tx.mediaUploadSession.update({
			where: { id: session.id },
			data: { stagingObjectKey: null },
		});
		if (input.sourceKey && session.asset.objectKey === `${input.sourceKey}.video-input.png`)
			await tx.storageUsageReservation.updateMany({
				where: { referenceKey: `media-upload:${session.id}`, status: "COMMITTED" },
				data: { bytes: session.asset.byteSize },
			});
		if (input.stagingKey)
			await tx.outboxEvent.updateMany({
				where: {
					eventType: "MEDIA_UPLOAD_CLEANUP",
					aggregateId: session.assetId,
					status: "PENDING",
					payload: { path: ["objectKey"], equals: input.stagingKey },
				},
				data: { status: "PROCESSED", processedAt: new Date() },
			});
	});
}
