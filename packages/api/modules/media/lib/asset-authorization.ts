import { ORPCError } from "@orpc/server";
import { getOwnedMediaAsset, getOwnedMediaUploadSession } from "@repo/database/media-assets";

export async function requireOwnedMediaAsset(assetId: string, ownerId: string) {
	const asset = await getOwnedMediaAsset(assetId, ownerId);
	if (!asset || asset.ownerType !== "USER" || asset.deletedAt || asset.status === "DELETED") {
		throw new ORPCError("NOT_FOUND");
	}
	return asset;
}

export async function requireReadyOwnedMediaAsset(assetId: string, ownerId: string) {
	const asset = await requireOwnedMediaAsset(assetId, ownerId);
	if (asset.status !== "READY") throw new ORPCError("PRECONDITION_FAILED");
	return asset;
}

export async function requireOwnedUploadSession(sessionId: string, ownerId: string) {
	const session = await getOwnedMediaUploadSession(sessionId, ownerId);
	if (!session || session.asset.ownerType !== "USER" || session.asset.ownerId !== ownerId) {
		throw new ORPCError("NOT_FOUND");
	}
	return session;
}
