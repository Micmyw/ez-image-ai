import { createHash } from "node:crypto";

import { approvedRumpelstiltskinMotionReferenceSchema } from "@repo/config/rumpelstiltskin-reference.server";
import { parseVideoEffectTemplateSnapshot } from "@repo/config/video-effects.server";
import { videoVisualSafetyProfileSchema } from "@repo/config/video-safety";

import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import type { MediaDatabaseClient } from "./types";
import { hasVideoApproval } from "./video-v1-fulfillment";

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** The approved envelope includes the measured media and manual rights receipt. */
export function fingerprintVideoTemplateReferenceApproval(envelope: unknown): string {
	return createHash("sha256")
		.update(
			JSON.stringify(envelope, (_key, value) =>
				value && typeof value === "object" && !Array.isArray(value)
					? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
					: value,
			),
		)
		.digest("hex");
}

export function isVideoTemplateReference(template: unknown): boolean {
	const value = object(template);
	return value.schemaVersion === 2 && value.executionKind === "seedance-reference";
}

/**
 * An environment manifest is only a binding, never moderation or rights evidence.
 * The admin-owned asset is deliberately not a user GenerationJobAsset relation.
 */
export async function findApprovedVideoTemplateMotionReference(
	template: unknown,
	tx: MediaDatabaseClient,
	now: Date,
) {
	const value = object(template);
	if (
		!isVideoTemplateReference(value) &&
		value.effectId !== "rumpelstiltskin-solo" &&
		value.schemaVersion !== 2
	)
		return null;
	const parsed = parseVideoEffectTemplateSnapshot(template);
	if (!isVideoTemplateReference(parsed)) throw new Error("VIDEO_TEMPLATE_REFERENCE_INVALID");
	const reference = approvedRumpelstiltskinMotionReferenceSchema.parse(
		object(parsed).approvedMotionReference,
	);
	await lockMediaAssetGenerationBindings([reference.assetId], tx);
	const asset = await tx.mediaAsset.findFirst({ where: { id: reference.assetId } });
	if (
		!asset ||
		asset.ownerType !== "USER" ||
		asset.ownerId !== reference.ownerId ||
		asset.kind !== "OUTPUT" ||
		asset.status !== "READY" ||
		!asset.finalizedAt ||
		asset.deletedAt ||
		(asset.deleteAfter && asset.deleteAfter <= now) ||
		asset.objectKey !== reference.objectKey ||
		asset.checksum !== reference.sha256 ||
		asset.storageEtag !== reference.etag ||
		asset.storageVersionId !== reference.storageVersionId ||
		asset.byteSize !== BigInt(reference.bytes) ||
		asset.mimeType !== reference.mimeType ||
		asset.durationMillis !== BigInt(Math.round(reference.durationSeconds * 1000)) ||
		asset.width !== reference.width ||
		asset.height !== reference.height ||
		asset.verificationGeneration !== reference.review.verificationGeneration ||
		asset.verificationProvider !== "seeapi" ||
		asset.verificationPolicyVersion !== reference.review.policyVersion ||
		!asset.verificationValidUntil ||
		asset.verificationValidUntil.getTime() !== Date.parse(reference.review.validUntil) ||
		asset.verificationValidUntil <= now ||
		Date.parse(reference.rights.validUntil) <= now.getTime()
	)
		throw new Error("VIDEO_TEMPLATE_REFERENCE_IDENTITY_CHANGED");
	const administrator = await tx.user.findFirst({
		where: { id: asset.ownerId, role: "admin" },
		select: { id: true },
	});
	if (!administrator) throw new Error("VIDEO_TEMPLATE_REFERENCE_OWNER_NOT_AUTHORIZED");
	const evidence = await tx.assetModerationResult.findFirst({
		where: {
			assetId: asset.id,
			assetChecksum: reference.sha256,
			verificationGeneration: reference.review.verificationGeneration,
			evidenceKind: "OUTPUT",
			provider: "seeapi",
			policyVersion: reference.review.policyVersion,
			status: "APPROVED",
			validUntil: new Date(reference.review.validUntil),
		},
		orderBy: { attemptNumber: "desc" },
	});
	const approval = object(object(evidence?.rawEnvelope).rumpelstiltskinReferenceApproval);
	const rights = object(approval.rights);
	const visualProfile = videoVisualSafetyProfileSchema.safeParse(
		object(evidence?.rawEnvelope).visualSafetyProfile,
	);
	if (
		!evidence ||
		!visualProfile.success ||
		visualProfile.data.provider !== "seeapi" ||
		!hasVideoApproval(
			{ ...asset, moderationResults: [evidence] },
			now,
			undefined,
			visualProfile.data,
			{ schemaVersion: 1, mode: "not_requested" },
		) ||
		fingerprintVideoTemplateReferenceApproval(evidence.rawEnvelope) !==
			reference.review.decisionHash ||
		approval.version !== reference.version ||
		approval.fps !== reference.fps ||
		approval.audioTrackCount !== 0 ||
		rights.approvalId !== reference.rights.approvalId ||
		rights.validUntil !== reference.rights.validUntil
	)
		throw new Error("VIDEO_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
	return asset;
}
