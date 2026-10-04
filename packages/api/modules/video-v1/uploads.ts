import { createHash, randomUUID } from "node:crypto";

import { isVideoModelOptionAllowed, readVideoModelAccess } from "@repo/config/video-model-access";
import { getVideoModelOptions, VIDEO_MODEL_CATALOG } from "@repo/config/video-models";
import { canAccessVideoV1, readVideoV1Config } from "@repo/config/video-v1";
import { db } from "@repo/database/client";
import { createMediaUploadSessionTransaction } from "@repo/database/media-assets";
import {
	getVideoUploadSession,
	recordVideoInputIdentity,
	releaseNormalizedSourceStorage,
} from "@repo/database/video-v1-uploads";
import { requireVideoAdmission } from "@repo/jobs/video-v1/admission";
import { getVideoWorkflowReadinessBindings } from "@repo/jobs/video-v1/workflow-binding";
import {
	createFinalAssetObjectKey,
	createStagingObjectKey,
	createSignedUpload,
	deleteObject,
	inspectPrivateImage,
	normalizeVideoReferenceToPng,
} from "@repo/storage";

import { loadUserPlanEntitlement } from "../media/lib/plan-entitlement";
import { enforceMediaRateLimit } from "../media/lib/rate-limit";
import { mediaUploadLimits } from "../media/lib/storage-limits";
import { completeOwnedUploadSession } from "../media/procedures/complete-upload-session";

type User = { id: string; role?: string | null };
type InputType = "image/jpeg" | "image/png" | "image/webp";
export function validateVideoUpload(
	input: { contentType: string; byteSize: number },
	maximumBytes: number,
): asserts input is { contentType: InputType; byteSize: number } {
	if (!["image/jpeg", "image/png", "image/webp"].includes(input.contentType))
		throw new Error("VIDEO_INPUT_TYPE_UNSUPPORTED");
	if (
		!Number.isSafeInteger(input.byteSize) ||
		input.byteSize <= 0 ||
		input.byteSize > Math.min(maximumBytes, 10_000_000)
	)
		throw new Error("INPUT_TOO_LARGE");
}

/** Uploads precede model selection; require at least one currently admitted image option. */
function requireVideoUploadAdmission(user: User) {
	const environment = process.env;
	const config = readVideoV1Config(environment);
	if (!canAccessVideoV1(config, user)) throw new Error("VIDEO_ACCESS_DENIED");
	const access = readVideoModelAccess(environment);
	if (!access.ready) throw new Error(access.reason ?? "VIDEO_MODEL_OPTIONS_NOT_CONFIGURED");
	const bindings = getVideoWorkflowReadinessBindings();
	let unavailable: unknown = new Error("VIDEO_MODEL_OPTION_NOT_ENABLED");
	const checked = new Set<string>();
	for (const model of VIDEO_MODEL_CATALOG) {
		for (const option of getVideoModelOptions(model.productKey, "image-to-video")) {
			const selection = {
				...option,
				productKey: model.productKey,
				mode: "image-to-video" as const,
			};
			if (!isVideoModelOptionAllowed(access, selection)) continue;
			// Ratios share readiness and pricing, so inspect each priced tuple only once.
			const key = JSON.stringify([
				model.productKey,
				option.duration,
				option.resolution,
				option.sound,
			]);
			if (checked.has(key)) continue;
			checked.add(key);
			try {
				return requireVideoAdmission(
					{ userId: user.id, role: user.role },
					environment,
					bindings,
					selection,
				);
			} catch (error) {
				unavailable = error;
			}
		}
	}
	throw unavailable;
}

export async function createVideoUpload(
	user: User,
	input: { contentType: string; byteSize: number },
) {
	const { config } = requireVideoUploadAdmission(user);
	const entitlement = await loadUserPlanEntitlement(user.id);
	const maximumBytes = Math.min(config.maxInputBytes, entitlement.maximumInputBytes);
	validateVideoUpload(input, maximumBytes);
	await enforceMediaRateLimit(user.id, "video-v1:upload");
	const assetId = randomUUID(),
		sessionId = randomUUID();
	const objectKey = createFinalAssetObjectKey(user.id, assetId, randomUUID(), input.contentType);
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
	const uploadUrl = await createSignedUpload({
		bucket: "media",
		key: stagingObjectKey,
		contentType: input.contentType,
		contentLength: input.byteSize,
	});
	return {
		assetId,
		sessionId,
		method: "PUT" as const,
		uploadUrl,
		expiresAt: expiresAt.toISOString(),
	};
}
export async function completeVideoUpload(user: User, input: { sessionId: string }) {
	const session = await getVideoUploadSession(user.id, input.sessionId);
	if (!session) throw new Error("VIDEO_UPLOAD_NOT_FOUND");
	// Disabling new admissions never strands already admitted uploads.
	await completeOwnedUploadSession(input, user.id, {
		expectedVerificationEngine: "video-workflow-v1",
	});
	const completed = await getVideoUploadSession(user.id, input.sessionId);
	if (!completed?.asset.checksum || !completed.asset.storageEtag || !completed.asset.finalizedAt)
		throw new Error("VIDEO_INPUT_NOT_SEALED");
	let asset = completed.asset;
	if (asset.width && asset.height && asset.mimeType !== "image/webp") return inputDto(asset);
	const entitlement = await loadUserPlanEntitlement(user.id);
	const maximumBytes = Math.min(entitlement.maximumInputBytes, 10_000_000);
	validateVideoUpload(
		{ contentType: asset.mimeType, byteSize: Number(asset.byteSize) },
		maximumBytes,
	);
	const source = { bucket: "media" as const, key: asset.objectKey };
	const dimensions = await inspectPrivateImage({
		...source,
		contentType: asset.mimeType as InputType,
		contentLength: Number(asset.byteSize),
		ifMatch: asset.storageEtag!,
	});
	let identity = {
		objectKey: asset.objectKey,
		checksum: asset.checksum!,
		etag: asset.storageEtag!,
		versionId: asset.storageVersionId,
		bytes: Number(asset.byteSize),
		mimeType: asset.mimeType as "image/jpeg" | "image/png",
	};
	if (asset.mimeType === "image/webp") {
		const final = { bucket: "media" as const, key: `${asset.objectKey}.video-input.png` };
		const normalized = await normalizeVideoReferenceToPng({
			source,
			final,
			sourceBytes: Number(asset.byteSize),
			sourceEtag: asset.storageEtag!,
			maximumBytes,
		});
		if (!normalized.etag) throw new Error("VIDEO_INPUT_NOT_SEALED");
		const normalizedDimensions = await inspectPrivateImage({
			...final,
			contentType: "image/png",
			contentLength: normalized.bytes,
			ifMatch: normalized.etag,
		});
		if (
			normalizedDimensions.width !== dimensions.width ||
			normalizedDimensions.height !== dimensions.height
		)
			throw new Error("VIDEO_INPUT_DIMENSIONS_CHANGED");
		identity = {
			objectKey: final.key,
			checksum: normalized.sha256,
			etag: normalized.etag,
			versionId: normalized.versionId,
			bytes: normalized.bytes,
			mimeType: "image/png",
		};
	}
	asset = await recordVideoInputIdentity({
		ownerId: user.id,
		sessionId: input.sessionId,
		sourceKey: asset.objectKey,
		sourceChecksum: asset.checksum!,
		...identity,
		...dimensions,
	});
	if (identity.objectKey !== source.key) {
		try {
			await deleteObject(source);
			await releaseNormalizedSourceStorage(user.id, input.sessionId, identity.objectKey);
		} catch {
			/* Keep its reserved bytes; dedicated recovery may clean this immutable orphan. */
		}
	}
	return inputDto(asset);
}
function inputDto(asset: {
	id: string;
	status: string;
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
