import { isImageAutomaticDeletionPaused } from "@repo/config";

import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { queueGuestAssetCleanup } from "./guest-asset-cleanup";
import type { MediaTransactionClient } from "./types";

export interface MediaStorageCleanupClaim {
	assetId: string;
	/** Every key that this invocation can physically delete, including promotion keys. */
	objectKeys: string[];
	uploadSessionId?: string;
	releasesReservation?: boolean;
}

export type MediaStorageCleanupDecision =
	| "DELETE"
	| "SKIP"
	| { outcome: "DEFER"; retainedObjectKey: string };

/**
 * Consumer fence, independent of the account-promotion feature flag. Never hold
 * a database transaction across storage I/O: a committed tombstone prevents a
 * later draft claim from adopting an object while physical deletion is in flight.
 */
export async function claimMediaStorageCleanupTransaction(
	input: MediaStorageCleanupClaim,
	client: MediaTransactionClient,
): Promise<MediaStorageCleanupDecision> {
	return client.$transaction(
		async (tx) => {
			await lockMediaAssetGenerationBindings([input.assetId], tx);
			// The sweeper also takes a row lock. Re-read after it returns, using a fresh
			// READ COMMITTED statement rather than a snapshot taken before waiting.
			await tx.$executeRaw`SELECT "id" FROM "media_asset" WHERE "id" = ${input.assetId} FOR UPDATE`;
			const asset = await tx.mediaAsset.findUnique({
				where: { id: input.assetId },
				include: { uploadSessions: { orderBy: { createdAt: "asc" } } },
			});
			if (!asset) return "DELETE";
			const touchesFinal = input.objectKeys.includes(asset.objectKey);
			if (!touchesFinal) {
				if (input.releasesReservation && (await imageCleanupPaused(asset, tx)))
					return { outcome: "DEFER", retainedObjectKey: asset.objectKey };
				// Normal staging cleanup is valid for a live account asset, but cannot
				// release the capacity occupied by its retained final object.
				if (input.releasesReservation && asset.status !== "DELETED")
					throw new Error("MEDIA_STORAGE_CLEANUP_RELEASE_WITHOUT_FINAL_KEY");
				return "DELETE";
			}
			const alreadyDeleted = asset.status === "DELETED" && asset.deletedAt;
			if (alreadyDeleted && !(await imageCleanupPaused(asset, tx))) return "DELETE";
			if (alreadyDeleted) return { outcome: "DEFER", retainedObjectKey: asset.objectKey };
			const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
			if (!clock) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
			const expiredUpload =
				asset.status === "UPLOADING" && input.uploadSessionId
					? await tx.mediaUploadSession.findFirst({
							where: {
								id: input.uploadSessionId,
								assetId: asset.id,
								status: { in: ["EXPIRED", "ABORTED"] },
							},
							select: { id: true },
						})
					: null;
			if (asset.retentionClass === "GUEST_TRIAL") {
				if (
					asset.status !== "VERIFICATION_FAILED" &&
					!expiredUpload &&
					(!asset.deleteAfter || asset.deleteAfter > clock.now)
				)
					throw new Error("MEDIA_STORAGE_CLEANUP_NOT_DUE");
			} else if (asset.status !== "VERIFICATION_FAILED") {
				// Old guest deadlines cannot remove a subsequently adopted account asset.
				if (asset.status !== "UPLOADING" || !expiredUpload) {
					const expiredDraft = await tx.generationDraft.findFirst({
						where: {
							assetId: asset.id,
							ownerId: asset.ownerId,
							status: "EXPIRED",
							expiresAt: { lte: clock.now },
						},
						select: { id: true },
					});
					if (
						!expiredDraft ||
						(await tx.generationJobAsset.findFirst({
							where: { assetId: asset.id },
							select: { jobId: true },
						}))
					)
						return "SKIP";
				}
			}
			if (await imageCleanupPaused(asset, tx))
				return { outcome: "DEFER", retainedObjectKey: asset.objectKey };
			// The deadline delivery has no reservation reference. Once tombstoned,
			// the sweeper will skip this row, so preserve its canonical cleanup and
			// capacity-release events atomically, using the original staging metadata.
			if (asset.retentionClass === "GUEST_TRIAL")
				await queueGuestAssetCleanup(asset, clock.now, tx);
			await tx.mediaAsset.update({
				where: { id: asset.id },
				data: {
					status: "DELETED",
					deletedAt: asset.deletedAt ?? clock.now,
					verificationValidUntil: null,
					verificationNextAttemptAt: null,
					verificationLeaseToken: null,
					verificationLeasedUntil: null,
					outputTransferToken: null,
					outputTransferLeaseExpiresAt: null,
					outputStagingObjectKey: null,
					outputPromotionMultipartUploadId: null,
				},
			});
			return "DELETE";
		},
		{ isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 20_000 },
	);
}

async function imageCleanupPaused(
	asset: Parameters<typeof queueGuestAssetCleanup>[0],
	tx: Parameters<typeof queueGuestAssetCleanup>[2],
): Promise<boolean> {
	if (isImageAutomaticDeletionPaused(asset)) {
		// Old expiration events may already have tombstoned the row. Only a
		// durable owner deletion/abort audit can bypass the retention pause.
		const explicitDeletion = await tx.auditLog.findFirst({
			where: {
				actorUserId: asset.ownerId,
				OR: [
					{ action: "MEDIA_ASSET_DELETED", targetType: "MEDIA_ASSET", targetId: asset.id },
					{
						action: "MEDIA_UPLOAD_ABORTED",
						targetType: "MEDIA_UPLOAD_SESSION",
						targetId: { in: asset.uploadSessions.map((session) => session.id) },
					},
				],
			},
			select: { id: true },
		});
		return !explicitDeletion;
	}
	return false;
}
