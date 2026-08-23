import { ORPCError } from "@orpc/server";
import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import {
	getOwnedMediaAsset,
	getOwnedMediaAssetReadState,
	getOwnedMediaUploadSession,
} from "@repo/database/media-assets";

export function currentMediaAssetVerificationBoundary(now = new Date()) {
	return {
		provider: process.env.MEDIA_SAFETY_ADAPTER ?? "test",
		ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
		policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		now,
	};
}

export async function requireOwnedMediaAsset(assetId: string, ownerId: string) {
	const asset = await getOwnedMediaAsset(assetId, ownerId);
	if (!asset || asset.ownerType !== "USER" || asset.deletedAt || asset.status === "DELETED") {
		throw new ORPCError("NOT_FOUND");
	}
	return asset;
}

export async function requireReadyOwnedMediaAsset(assetId: string, ownerId: string) {
	const state = await getOwnedMediaAssetReadState({
		assetId,
		ownerId,
		verification: currentMediaAssetVerificationBoundary(),
	});
	if (
		!state ||
		state.asset.ownerType !== "USER" ||
		state.asset.deletedAt ||
		state.asset.status === "DELETED"
	) {
		throw new ORPCError("NOT_FOUND");
	}
	if (!state.readable) throw new ORPCError("PRECONDITION_FAILED");
	return state.asset;
}

export async function requireOwnedUploadSession(sessionId: string, ownerId: string) {
	const session = await getOwnedMediaUploadSession(sessionId, ownerId);
	if (
		!session ||
		session.asset.ownerType !== "USER" ||
		session.asset.ownerId !== ownerId ||
		(session.status !== "ABORTED" &&
			(session.asset.deletedAt ||
				(session.status !== "COMPLETED" && session.asset.status !== "UPLOADING")))
	) {
		throw new ORPCError("NOT_FOUND");
	}
	return session;
}
