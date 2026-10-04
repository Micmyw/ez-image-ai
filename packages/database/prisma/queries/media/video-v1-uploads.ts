import { getDatabaseClient } from "../../client";
import { lockOwnerStorageUsage } from "./storage-usage-locks";
import { runSerializable } from "./types";

export async function getVideoUploadSession(ownerId: string, sessionId: string) {
	return getDatabaseClient().mediaUploadSession.findFirst({
		where: {
			id: sessionId,
			asset: {
				ownerType: "USER",
				ownerId,
				verificationEngine: "video-workflow-v1",
				kind: "INPUT",
				deletedAt: null,
			},
		},
		include: { asset: true },
	});
}

/** Completes server inspection before the asset is eligible for any video quote. */
export async function recordVideoInputIdentity(input: {
	ownerId: string;
	sessionId: string;
	sourceKey: string;
	sourceChecksum: string;
	objectKey: string;
	checksum: string;
	etag: string;
	versionId: string | null;
	bytes: number;
	mimeType: "image/jpeg" | "image/png";
	width: number;
	height: number;
}) {
	return runSerializable(getDatabaseClient(), async (tx) => {
		await lockOwnerStorageUsage({ ownerType: "USER", ownerId: input.ownerId }, tx);
		const session = await tx.mediaUploadSession.findFirst({
			where: {
				id: input.sessionId,
				status: "COMPLETED",
				asset: {
					ownerType: "USER",
					ownerId: input.ownerId,
					verificationEngine: "video-workflow-v1",
					deletedAt: null,
				},
			},
			include: { asset: true },
		});
		if (!session) throw new Error("VIDEO_UPLOAD_NOT_FOUND");
		const asset = session.asset;
		if (
			asset.width &&
			asset.height &&
			asset.objectKey === input.objectKey &&
			asset.checksum === input.checksum
		)
			return asset;
		if (
			asset.objectKey !== input.sourceKey ||
			asset.checksum !== input.sourceChecksum ||
			asset.status !== "VERIFYING"
		)
			throw new Error("VIDEO_INPUT_IDENTITY_CONFLICT");
		if (await tx.generationJobAsset.count({ where: { assetId: asset.id } }))
			throw new Error("VIDEO_INPUT_ALREADY_BOUND");
		const reserve = await tx.storageUsageReservation.findUnique({
			where: { referenceKey: `media-upload:${session.id}` },
		});
		const stillStoredSource = input.objectKey !== input.sourceKey ? asset.byteSize : 0n;
		const totalBytes = BigInt(input.bytes) + stillStoredSource;
		if (!reserve || reserve.bytes < totalBytes) throw new Error("STORAGE_QUOTA_EXCEEDED");
		const updated = await tx.mediaAsset.update({
			where: { id: asset.id },
			data: {
				objectKey: input.objectKey,
				checksum: input.checksum,
				storageEtag: input.etag,
				storageVersionId: input.versionId,
				byteSize: BigInt(input.bytes),
				mimeType: input.mimeType,
				width: input.width,
				height: input.height,
				deleteAfter: new Date(Date.now() + 86_400_000),
			},
		});
		await tx.storageUsageReservation.update({
			where: { id: reserve.id },
			data: { bytes: totalBytes },
		});
		return updated;
	});
}

/** Called only after the obsolete immutable WebP source was successfully deleted. */
export async function releaseNormalizedSourceStorage(
	ownerId: string,
	sessionId: string,
	finalKey: string,
) {
	return runSerializable(getDatabaseClient(), async (tx) => {
		await lockOwnerStorageUsage({ ownerType: "USER", ownerId }, tx);
		const session = await tx.mediaUploadSession.findFirst({
			where: {
				id: sessionId,
				status: "COMPLETED",
				asset: {
					ownerId,
					ownerType: "USER",
					objectKey: finalKey,
					verificationEngine: "video-workflow-v1",
				},
			},
			include: { asset: true },
		});
		if (!session) return;
		await tx.storageUsageReservation.updateMany({
			where: { referenceKey: `media-upload:${sessionId}`, status: "COMMITTED" },
			data: { bytes: session.asset.byteSize },
		});
	});
}
