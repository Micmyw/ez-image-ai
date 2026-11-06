import { createHash, randomUUID } from "node:crypto";

import type { SourceTemplatePublicRequest } from "@repo/config/video-template-execution.server";
import { db } from "@repo/database/client";
import { createMediaUploadSessionTransaction } from "@repo/database/media-assets";
import { getSourceTemplateInputRecord } from "@repo/database/video-source-template-admission";
import { sourceTemplateAccess } from "@repo/jobs/video-v1/source-template-admission";
import { getVideoWorkflowReadinessBindings } from "@repo/jobs/video-v1/workflow-binding";
import {
	createFinalAssetObjectKey,
	createStagingObjectKey,
	createSignedUpload,
} from "@repo/storage";

import { requireReadyOwnedMediaAsset } from "../media/lib/asset-authorization";
import { signAuthorizedAssetReadUrl } from "../media/lib/asset-read-url";
import { loadUserPlanEntitlement } from "../media/lib/plan-entitlement";
import { enforceMediaRateLimit } from "../media/lib/rate-limit";
import { mediaUploadLimits } from "../media/lib/storage-limits";
import { validateVideoUpload } from "../video-v1/uploads";
export { completeVideoUpload as completeSourceTemplateUpload } from "../video-v1/uploads";

export async function createSourceTemplateUpload(
	user: { id: string; role?: string | null },
	input: {
		templateKey: SourceTemplatePublicRequest["templateKey"];
		contentType: string;
		byteSize: number;
	},
) {
	const access = await sourceTemplateAccess(
		{ userId: user.id, role: user.role },
		input.templateKey,
		getVideoWorkflowReadinessBindings(),
	);
	if (!access.available) throw new Error(access.reasons[0] ?? "VIDEO_TEMPLATE_NOT_READY");
	const entitlement = await loadUserPlanEntitlement(user.id);
	const maximumBytes = Math.min(access.maximumInputBytes, entitlement.maximumInputBytes);
	validateVideoUpload(input, maximumBytes);
	await enforceMediaRateLimit(user.id, "video-templates:upload");
	const assetId = randomUUID(),
		sessionId = randomUUID();
	const objectKey = createFinalAssetObjectKey(user.id, assetId, randomUUID(), input.contentType);
	const stagingObjectKey = createStagingObjectKey(
		user.id,
		sessionId,
		randomUUID(),
		input.contentType,
	);
	const expiresAt = new Date(Date.now() + 86400000);
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
			reservedBytes: BigInt(
				input.contentType === "image/webp" ? maximumBytes + input.byteSize : input.byteSize,
			),
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

/** History/handoff reauthorizes the opaque ID; a browser URL is never an input. */
export async function getSourceTemplateInput(ownerId: string, assetId: string) {
	const asset = await getSourceTemplateInputRecord(ownerId, assetId, db);
	if (!asset || (asset.kind === "OUTPUT" && asset.status !== "READY")) throw new Error("NOT_FOUND");
	let preview: Awaited<ReturnType<typeof signAuthorizedAssetReadUrl>> | null = null;
	try {
		preview = await signAuthorizedAssetReadUrl(await requireReadyOwnedMediaAsset(assetId, ownerId));
	} catch {
		/* Metadata remains private; review is required before any provider use. */
	}
	if (asset.kind === "OUTPUT" && !preview) throw new Error("VIDEO_INPUT_NOT_AVAILABLE");
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
