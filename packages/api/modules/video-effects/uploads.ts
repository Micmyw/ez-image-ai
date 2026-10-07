import { createHash, randomUUID } from "node:crypto";

import { VIDEO_EFFECT_MAX_INPUT_BYTES, type VideoEffectId } from "@repo/config/video-effects";
import { db } from "@repo/database/client";
import { createMediaUploadSessionTransaction } from "@repo/database/media-assets";
import {
	getVideoTemplateInputRecord,
	getVideoTemplateInputReadAuthorization,
} from "@repo/database/video-template";
import {
	getVideoUploadSession,
	recordVideoInputIdentity,
	releaseNormalizedSourceStorage,
} from "@repo/database/video-v1-uploads";
import {
	VIDEO_EFFECT_CAPABILITY_REQUEST,
	requireVideoTemplateAdmission,
	requireVideoTemplateRuntimeEnabled,
} from "@repo/jobs/video-v1/template-admission";
import { getVideoWorkflowReadinessBindings } from "@repo/jobs/video-v1/workflow-binding";
import {
	createFinalAssetObjectKey,
	createStagingObjectKey,
	createSignedUpload,
	deleteObject,
	inspectPrivateImage,
	normalizeVideoReferenceToPng,
} from "@repo/storage";

import { signAuthorizedAssetReadUrl } from "../media/lib/asset-read-url";
import { loadUserPlanEntitlement } from "../media/lib/plan-entitlement";
import { enforceMediaRateLimit } from "../media/lib/rate-limit";
import { mediaUploadLimits } from "../media/lib/storage-limits";
import { completeOwnedUploadSession } from "../media/procedures/complete-upload-session";
import { validateVideoUpload } from "../video-v1/uploads";

export async function createVideoEffectUpload(
	user: { id: string; role?: string | null },
	input: { contentType: string; byteSize: number; effectId?: VideoEffectId },
) {
	const admission = requireVideoTemplateAdmission(
		{ userId: user.id, role: user.role },
		process.env,
		getVideoWorkflowReadinessBindings(),
		{
			...VIDEO_EFFECT_CAPABILITY_REQUEST,
			effectId: input.effectId ?? "hotel-lobby-duo",
			inputs: { leftAssetId: "capability", rightAssetId: "capability" },
		},
	);
	await requireVideoTemplateRuntimeEnabled(admission.template);
	const entitlement = await loadUserPlanEntitlement(user.id);
	const maximumBytes = Math.min(
		VIDEO_EFFECT_MAX_INPUT_BYTES,
		entitlement.maximumInputBytes,
		admission.maximumInputBytes,
	);
	validateVideoUpload(input, maximumBytes);
	await enforceMediaRateLimit(user.id, "video-effects:upload");
	const assetId = randomUUID(),
		sessionId = randomUUID();
	// A server-owned, persisted key distinguishes canonical template uploads from ordinary video uploads.
	const objectKey = `${createFinalAssetObjectKey(user.id, assetId, randomUUID(), input.contentType)}.template-source`;
	const stagingObjectKey = createStagingObjectKey(
		user.id,
		sessionId,
		randomUUID(),
		input.contentType,
	);
	const expiresAt = new Date(Date.now() + 86_400_000);
	await createMediaUploadSessionTransaction(
		{
			assetId,
			sessionId,
			ownerType: "USER",
			ownerId: user.id,
			kind: "INPUT",
			objectKey,
			stagingObjectKey,
			verificationEngine: "video-workflow-v1",
			mimeType: input.contentType,
			expectedBytes: BigInt(input.byteSize),
			reservedBytes: BigInt(input.byteSize + maximumBytes),
			tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
			expiresAt,
			multipartUploadId: null,
			limits: mediaUploadLimits(),
		},
		db,
	);
	return {
		assetId,
		sessionId,
		method: "PUT" as const,
		uploadUrl: await createSignedUpload({
			bucket: "media",
			key: stagingObjectKey,
			contentType: input.contentType,
			contentLength: input.byteSize,
		}),
		expiresAt: expiresAt.toISOString(),
	};
}

/** Completing an accepted upload stays possible after new template admissions are disabled. */
export async function completeVideoEffectUpload(
	user: { id: string },
	input: { sessionId: string },
) {
	const session = await getVideoUploadSession(user.id, input.sessionId);
	if (
		!session ||
		(!session.asset.objectKey.endsWith(".template-source") &&
			!session.asset.objectKey.endsWith(".template-source.template-input.png"))
	)
		throw new Error("VIDEO_UPLOAD_NOT_FOUND");
	await completeOwnedUploadSession(input, user.id, {
		expectedVerificationEngine: "video-workflow-v1",
	});
	const completed = await getVideoUploadSession(user.id, input.sessionId);
	if (!completed?.asset.checksum || !completed.asset.storageEtag || !completed.asset.finalizedAt)
		throw new Error("VIDEO_INPUT_NOT_SEALED");
	const asset = completed.asset;
	if (
		asset.objectKey.endsWith(".template-source.template-input.png") &&
		asset.width &&
		asset.height
	) {
		// A lost response can leave the obsolete source object; reclaim only after confirmed deletion.
		await cleanupTemplateSource(user.id, input.sessionId, asset.objectKey).catch(() => undefined);
		return sealedInputDto(asset);
	}
	const entitlement = await loadUserPlanEntitlement(user.id);
	const maximumBytes = Math.min(VIDEO_EFFECT_MAX_INPUT_BYTES, entitlement.maximumInputBytes);
	const sourceInput = { contentType: asset.mimeType, byteSize: Number(asset.byteSize) };
	validateVideoUpload(sourceInput, maximumBytes);
	const source = { bucket: "media" as const, key: asset.objectKey };
	// Both checks genuinely decode the content. Orientation may change dimensions during normalization.
	await inspectPrivateImage({
		...source,
		contentType: sourceInput.contentType,
		contentLength: sourceInput.byteSize,
		ifMatch: asset.storageEtag!,
	});
	const final = { bucket: "media" as const, key: `${asset.objectKey}.template-input.png` };
	const normalized = await normalizeVideoReferenceToPng({
		source,
		final,
		sourceBytes: sourceInput.byteSize,
		sourceEtag: asset.storageEtag!,
		sourceContentType: sourceInput.contentType,
		maximumBytes,
	});
	if (!normalized.etag) throw new Error("VIDEO_INPUT_NOT_SEALED");
	const dimensions = await inspectPrivateImage({
		...final,
		contentType: "image/png",
		contentLength: normalized.bytes,
		ifMatch: normalized.etag,
	});
	const sealed = await recordVideoInputIdentity({
		ownerId: user.id,
		sessionId: input.sessionId,
		sourceKey: asset.objectKey,
		sourceChecksum: asset.checksum!,
		objectKey: final.key,
		checksum: normalized.sha256,
		etag: normalized.etag,
		versionId: normalized.versionId,
		bytes: normalized.bytes,
		mimeType: "image/png",
		...dimensions,
	});
	await cleanupTemplateSource(user.id, input.sessionId, final.key).catch(() => undefined);
	return sealedInputDto(sealed);
}

async function cleanupTemplateSource(ownerId: string, sessionId: string, finalKey: string) {
	if (!finalKey.endsWith(".template-source.template-input.png"))
		throw new Error("VIDEO_INPUT_NOT_SEALED");
	await deleteObject({ bucket: "media", key: finalKey.slice(0, -".template-input.png".length) });
	await releaseNormalizedSourceStorage(ownerId, sessionId, finalKey);
}

function sealedInputDto(asset: {
	id: string;
	mimeType: string;
	byteSize: bigint;
	width: number | null;
	height: number | null;
}) {
	return {
		assetId: asset.id,
		status: "VERIFYING" as const,
		uploadStatus: "COMPLETED" as const,
		moderationStatus: "PENDING" as const,
		mimeType: asset.mimeType,
		byteSize: asset.byteSize.toString(),
		width: asset.width!,
		height: asset.height!,
	};
}

export async function getVideoEffectInput(ownerId: string, assetId: string) {
	const asset = await getVideoTemplateInputRecord(ownerId, assetId, db);
	if (!asset) throw new Error("NOT_FOUND");
	let preview: { url: string; expiresAt: string } | null = null;
	// Pending photographs can restore their IDs, but no unchecked storage URL is returned.
	// Template evidence binds owner, both role identities and the frozen safety policy.
	try {
		const approved = await getVideoTemplateInputReadAuthorization(ownerId, assetId, db);
		if (approved) preview = await signAuthorizedAssetReadUrl(approved);
	} catch {
		// Recovery metadata is useful before input review; unavailable previews remain private.
	}
	return {
		assetId: asset.id,
		mimeType: asset.mimeType,
		byteSize: asset.byteSize.toString(),
		width: asset.width!,
		height: asset.height!,
		sealed: true as const,
		previewUrl: preview?.url ?? null,
		previewExpiresAt: preview?.expiresAt ?? null,
	};
}
