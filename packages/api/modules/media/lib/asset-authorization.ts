import { ORPCError } from "@orpc/server";
import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { imageModerationProviderForEnvironment } from "@repo/config";
import {
	getOwnedMediaAsset,
	getOwnedMediaAssetReadState,
	getOwnedMediaUploadSession,
} from "@repo/database/media-assets";

import { publicImageModerationReason } from "./public-moderation-reason";

export function currentMediaAssetVerificationBoundary(now = new Date()) {
	return {
		provider: imageModerationProviderForEnvironment(process.env),
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
	if (!state.readable) {
		const message = publicImageModerationReason(state.asset.moderationResults?.[0])
			? "ASSET_CONTENT_NOT_ALLOWED"
			: state.asset.status === "QUARANTINED" || state.asset.status === "VERIFICATION_FAILED"
				? "ASSET_SAFETY_UNAVAILABLE"
				: "ASSET_SAFETY_PENDING";
		throw new ORPCError("PRECONDITION_FAILED", {
			message,
			...(message === "ASSET_CONTENT_NOT_ALLOWED"
				? {
						data: {
							moderationReason: publicImageModerationReason(state.asset.moderationResults?.[0]),
						},
					}
				: {}),
		});
	}
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
