import { createHash, randomUUID } from "node:crypto";

import { parseVideoEffectTemplateSnapshot } from "@repo/config/video-effects.server";
import { readVideoInternalFundingSnapshot } from "@repo/config/video-internal-funding";
import {
	isApprovedVideoTextDecision,
	readVideoTextSafetyProfile,
	videoTextSafetyProfilesMatch,
} from "@repo/config/video-text-safety";

import { getDatabaseClient } from "../../client";
import type { Prisma } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { runReadCommitted } from "./types";
import { recordVideoTemplateBusinessEvent } from "./video-template-events";
import {
	findApprovedVideoTemplateMotionReference,
	isVideoTemplateReference,
} from "./video-template-reference";
import {
	videoTemplateSceneReservationBytes,
	videoTemplateSceneReservationKey,
} from "./video-template-storage";
import { lockVideoOwnerStorage } from "./video-v1-storage";
export { findApprovedVideoTemplateMotionReference } from "./video-template-reference";
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const json = (v: unknown): Prisma.InputJsonObject =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Prisma.InputJsonObject) : {};
const include = {
	sceneAsset: true,
	job: {
		include: { assets: { include: { asset: true } }, videoExecution: true, reservation: true },
	},
} satisfies Prisma.VideoTemplateExecutionInclude;
export function getVideoTemplateExecution(jobId: string) {
	return getDatabaseClient().videoTemplateExecution.findUnique({ where: { jobId }, include });
}
async function lock(tx: Prisma.TransactionClient, jobId: string) {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`video-v1:${jobId}`},0))`;
	const execution = await tx.videoTemplateExecution.findUnique({ where: { jobId }, include });
	if (!execution || execution.job.executionEngine !== "video-workflow-v1")
		throw new Error("VIDEO_TEMPLATE_JOB_NOT_FOUND");
	return execution;
}
function active(execution: NonNullable<Awaited<ReturnType<typeof getVideoTemplateExecution>>>) {
	if (
		!execution.job.videoExecution ||
		["READY", "FAILED", "REJECTED", "NEEDS_REVIEW"].includes(execution.job.videoExecution.stage)
	)
		throw new Error("VIDEO_JOB_TERMINAL");
}
export function assertVideoTemplateRoleIdentities(job: {
	ownerType: string;
	ownerId: string;
	inputSnapshot: Prisma.JsonValue;
	assets: Array<{
		role: string;
		assetId: string;
		assetChecksum: string;
		asset: {
			ownerType: string;
			ownerId: string;
			deletedAt: Date | null;
			finalizedAt: Date | null;
			status: string;
			checksum: string | null;
			objectKey: string;
			storageEtag: string | null;
			storageVersionId: string | null;
			verificationGeneration: number;
			deleteAfter: Date | null;
		};
	}>;
}) {
	const identities = json(job.inputSnapshot).roleInputIdentities;
	if (!Array.isArray(identities) || identities.length !== 2)
		throw new Error("VIDEO_TEMPLATE_IDENTITIES_INVALID");
	for (const [position, value] of identities.entries()) {
		const identity = json(value);
		const binding = job.assets.find((b) => b.role === "INPUT" && b.assetId === identity.assetId);
		const asset = binding?.asset;
		if (
			identity.role !== (position === 0 ? "left" : "right") ||
			!asset ||
			asset.ownerType !== job.ownerType ||
			asset.ownerId !== job.ownerId ||
			asset.deletedAt ||
			!asset.finalizedAt ||
			["DELETED", "QUARANTINED"].includes(asset.status) ||
			asset.checksum !== identity.checksum ||
			binding?.assetChecksum !== identity.checksum ||
			asset.objectKey !== identity.objectKey ||
			asset.storageEtag !== identity.storageEtag ||
			asset.storageVersionId !== identity.storageVersionId ||
			asset.verificationGeneration !== identity.verificationGeneration ||
			(asset.deleteAfter && asset.deleteAfter <= new Date())
		)
			throw new Error("VIDEO_INPUT_IDENTITY_CHANGED");
	}
}
export function getVideoEffectiveInputSnapshot(job: {
	inputSnapshot: Prisma.JsonValue;
	videoTemplateExecution?: {
		resolvedInputIdentity: Prisma.JsonValue | null;
		sceneState: string;
	} | null;
}) {
	const snapshot = json(job.inputSnapshot);
	if (!snapshot.videoEffectTemplate) return snapshot;
	const sidecar = job.videoTemplateExecution;
	const identity = json(sidecar?.resolvedInputIdentity);
	if (!sidecar || sidecar.sceneState !== "READY" || !identity.assetId)
		throw new Error("VIDEO_TEMPLATE_SCENE_NOT_READY");
	const template = json(snapshot.videoEffectTemplate);
	if (isVideoTemplateReference(template)) {
		parseVideoEffectTemplateSnapshot(template);
		const evidence = json(identity.sourceReviewEvidence);
		const review = json(evidence.left);
		const profile = readVideoTextSafetyProfile(snapshot);
		const motionIdentity = json(evidence.motionTextDecisionIdentity);
		if (
			identity.source !== "subject-reference" ||
			identity.parentRequestFingerprint !== snapshot.requestFingerprint ||
			evidence.status !== "ALLOW" ||
			evidence.requestFingerprint !== snapshot.requestFingerprint ||
			!videoTextSafetyProfilesMatch(evidence.textSafetyProfile, profile) ||
			!isApprovedVideoTextDecision(evidence.motionTextDecision, profile) ||
			motionIdentity.requestFingerprint !== snapshot.requestFingerprint ||
			motionIdentity.promptVersion !== json(template.video).promptVersion ||
			motionIdentity.promptHash !==
				createHash("sha256")
					.update(text(json(template.video).prompt))
					.digest("hex") ||
			json(review.decision).decision !== "ALLOW" ||
			review.assetId !== identity.assetId ||
			review.checksum !== identity.checksum ||
			review.objectKey !== identity.objectKey ||
			review.storageEtag !== identity.storageEtag ||
			review.storageVersionId !== identity.storageVersionId ||
			review.verificationGeneration !== identity.verificationGeneration ||
			review.safetyPolicyVersion !== template.safetyPolicyVersion ||
			typeof review.validUntil !== "string" ||
			!Number.isFinite(Date.parse(review.validUntil)) ||
			Date.parse(review.validUntil) <= Date.now()
		)
			throw new Error("VIDEO_TEMPLATE_REFERENCE_INPUT_REVIEW_REQUIRED");
		const second = json(evidence.right);
		if (
			json(second.decision).decision !== "ALLOW" ||
			second.assetId !== identity.assetId ||
			second.checksum !== identity.checksum ||
			second.objectKey !== identity.objectKey ||
			second.storageEtag !== identity.storageEtag ||
			second.storageVersionId !== identity.storageVersionId ||
			second.verificationGeneration !== identity.verificationGeneration ||
			second.safetyPolicyVersion !== template.safetyPolicyVersion ||
			typeof second.validUntil !== "string" ||
			!Number.isFinite(Date.parse(second.validUntil)) ||
			Date.parse(second.validUntil) <= Date.now()
		)
			throw new Error("VIDEO_TEMPLATE_REFERENCE_INPUT_REVIEW_REQUIRED");
		return { ...snapshot, inputAssetId: identity.assetId, inputIdentity: identity };
	}
	const review = json(json(identity.sceneReviewEvidence).scene);
	if (
		identity.parentRequestFingerprint !== snapshot.requestFingerprint ||
		json(identity.sceneReviewEvidence).status !== "ALLOW" ||
		json(review.decision).decision !== "ALLOW" ||
		review.assetId !== identity.assetId ||
		review.checksum !== identity.checksum ||
		review.objectKey !== identity.objectKey ||
		review.storageEtag !== identity.storageEtag ||
		review.storageVersionId !== identity.storageVersionId ||
		review.verificationGeneration !== identity.verificationGeneration ||
		review.safetyPolicyVersion !== template.safetyPolicyVersion
	)
		throw new Error("VIDEO_TEMPLATE_SCENE_REVIEW_INVALID");
	if (
		typeof review.validUntil !== "string" ||
		!Number.isFinite(Date.parse(review.validUntil)) ||
		Date.parse(review.validUntil) <= Date.now()
	)
		throw new Error("VIDEO_TEMPLATE_SCENE_REVIEW_EXPIRED");

	return { ...snapshot, inputAssetId: identity.assetId, inputIdentity: identity };
}
export async function recordVideoTemplateReview(
	jobId: string,
	stage: "inputs" | "scene",
	patch: Record<string, unknown>,
) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const e = await lock(tx, jobId);
		active(e);
		assertVideoTemplateRoleIdentities(e.job);
		await findApprovedVideoTemplateMotionReference(e.templateSnapshot, tx, new Date());
		const field = stage === "inputs" ? "inputReview" : "sceneReview";
		await tx.videoTemplateExecution.update({
			where: { jobId },
			data: {
				[field]: { ...json(e[field]), ...patch } as Prisma.InputJsonValue,
				stageData: {
					...json(e.stageData),
					...(patch.status === "ALLOW"
						? {
								[stage === "inputs" ? "inputReviewCompletedAt" : "sceneReviewCompletedAt"]:
									new Date().toISOString(),
							}
						: {}),
				},
			},
		});
	});
}
export async function claimVideoTemplateImageReview(
	jobId: string,
	role: "left" | "right" | "scene",
) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const e = await lock(tx, jobId);
		active(e);
		if (role !== "scene") assertVideoTemplateRoleIdentities(e.job);
		await findApprovedVideoTemplateMotionReference(e.templateSnapshot, tx, new Date());
		const field = role === "scene" ? "sceneReview" : "inputReview";
		const reviews = json(e[field]);
		const review = json(reviews[role]);
		if (review.submissionUncertain || review.taskId || review.decision) return false;
		await tx.videoTemplateExecution.update({
			where: { jobId },
			data: {
				[field]: {
					...reviews,
					[role]: { ...review, submissionUncertain: true, submittedAt: new Date().toISOString() },
				},
			},
		});
		return true;
	});
}
export async function recordVideoTemplateImageReview(
	jobId: string,
	role: "left" | "right" | "scene",
	patch: Record<string, unknown>,
) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const e = await lock(tx, jobId);
		active(e);
		const field = role === "scene" ? "sceneReview" : "inputReview";
		const reviews = json(e[field]);
		const old = json(reviews[role]);
		if (old.taskId && patch.taskId && old.taskId !== patch.taskId)
			throw new Error("VIDEO_TEMPLATE_REVIEW_TASK_CONFLICT");
		await tx.videoTemplateExecution.update({
			where: { jobId },
			data: { [field]: { ...reviews, [role]: { ...old, ...patch } } as Prisma.InputJsonValue },
		});
	});
}
export async function claimVideoTemplateSceneSubmission(input: {
	jobId: string;
	callbackTokenHash: string;
}) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		await lockVideoOwnerStorage(tx, input.jobId);
		const e = await lock(tx, input.jobId);
		if (isVideoTemplateReference(e.templateSnapshot))
			throw new Error("VIDEO_TEMPLATE_REFERENCE_HAS_NO_SCENE");
		if (e.submittedAt) return { execution: e, claimed: false };
		active(e);
		assertVideoTemplateRoleIdentities(e.job);
		const review = json(e.inputReview);
		const profile = readVideoTextSafetyProfile(e.job.inputSnapshot);
		if (
			review.status !== "ALLOW" ||
			review.requestFingerprint !== json(e.job.inputSnapshot).requestFingerprint ||
			!videoTextSafetyProfilesMatch(review.textSafetyProfile, profile) ||
			!isApprovedVideoTextDecision(review.sceneTextDecision, profile) ||
			!isApprovedVideoTextDecision(review.motionTextDecision, profile)
		)
			throw new Error("VIDEO_TEMPLATE_INPUT_REVIEW_REQUIRED");
		for (const identityValue of e.orderedRoleIdentities as Prisma.JsonArray) {
			const identity = json(identityValue);
			const r = json(review[text(identity.role)]);
			if (
				json(r.decision).decision !== "ALLOW" ||
				r.checksum !== identity.checksum ||
				r.objectKey !== identity.objectKey ||
				r.assetId !== identity.assetId ||
				r.verificationGeneration !== identity.verificationGeneration ||
				r.safetyPolicyVersion !== json(e.templateSnapshot).safetyPolicyVersion ||
				typeof r.validUntil !== "string" ||
				!Number.isFinite(Date.parse(r.validUntil)) ||
				Date.parse(r.validUntil) <= Date.now()
			)
				throw new Error("VIDEO_TEMPLATE_INPUT_REVIEW_REQUIRED");
		}
		const capacity = await tx.storageUsageReservation.findUnique({
			where: { referenceKey: videoTemplateSceneReservationKey(input.jobId) },
		});
		if (
			!capacity ||
			capacity.ownerId !== e.job.ownerId ||
			capacity.status !== "ACTIVE" ||
			capacity.bytes < videoTemplateSceneReservationBytes(e.job.inputSnapshot)
		)
			throw new Error("VIDEO_STORAGE_RESERVATION_REQUIRED");
		const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
		if (!clock) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
		const price = json(json(e.job.pricingSnapshot).pricingDetails);
		if (
			typeof price.validUntil !== "string" ||
			Date.parse(price.validUntil) <= clock.now.getTime() ||
			!Number.isFinite(Date.parse(price.validUntil))
		)
			throw new Error("VIDEO_PRICE_EXPIRED");
		if (
			price.funding !== undefined &&
			(!readVideoInternalFundingSnapshot(price.funding, e.job.ownerId, clock.now) ||
				price.paidRevenueQualified !== false)
		)
			throw new Error("VIDEO_FUNDING_POLICY_CHANGED");
		const execution = await tx.videoTemplateExecution.update({
			where: { jobId: input.jobId },
			data: {
				sceneState: "SUBMITTING",
				sceneSubmissionUncertain: true,
				sceneCallbackTokenHash: input.callbackTokenHash,
				submittedAt: new Date(),
			},
			include,
		});
		return { execution, claimed: true };
	});
}
export async function recordVideoTemplateSceneAccepted(jobId: string, taskId: string) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const e = await lock(tx, jobId);
		if (!e.submittedAt || !taskId || (e.sceneProviderTaskId && e.sceneProviderTaskId !== taskId))
			throw new Error("VIDEO_TEMPLATE_SCENE_TASK_CONFLICT");
		if (e.sceneProviderTaskId) return e;
		return tx.videoTemplateExecution.update({
			where: { jobId },
			data: {
				sceneProviderTaskId: taskId,
				sceneSubmissionUncertain: false,
				sceneState: "GENERATING",
				acceptedAt: new Date(),
			},
			include,
		});
	});
}
export async function recordVideoTemplateSceneProviderResult(input: {
	jobId: string;
	taskId: string;
	evidence: Record<string, unknown>;
}) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const e = await lock(tx, input.jobId);
		if (e.sceneProviderTaskId !== input.taskId)
			throw new Error("VIDEO_TEMPLATE_SCENE_TASK_CONFLICT");
		if (e.sceneProviderEvidence) return e;
		if (!["SUCCEEDED", "FAILED"].includes(text(input.evidence.status)))
			throw new Error("VIDEO_TEMPLATE_SCENE_RESULT_INVALID");
		active(e);
		return tx.videoTemplateExecution.update({
			where: { jobId: input.jobId },
			data: {
				sceneProviderEvidence: input.evidence as Prisma.InputJsonValue,
				sceneSubmissionUncertain: false,
				sceneState: input.evidence.status === "FAILED" ? "FAILED" : "STORING",
				completedAt: new Date(),
			},
			include,
		});
	});
}
export async function prepareVideoTemplateSceneAsset(jobId: string) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		await lockVideoOwnerStorage(tx, jobId);
		const e = await lock(tx, jobId);
		active(e);
		const lease = {
			outputTransferToken: randomUUID(),
			outputTransferLeaseExpiresAt: new Date(Date.now() + 600000),
		};
		if (e.sceneAsset) {
			if (e.sceneAsset.finalizedAt) return e.sceneAsset;
			if (e.sceneAsset.deletedAt) throw new Error("VIDEO_TEMPLATE_SCENE_ASSET_UNAVAILABLE");
			if (
				e.sceneAsset.outputTransferLeaseExpiresAt &&
				e.sceneAsset.outputTransferLeaseExpiresAt > new Date()
			)
				throw new Error("VIDEO_TEMPLATE_SCENE_TRANSFER_BUSY");
			return tx.mediaAsset.update({ where: { id: e.sceneAsset.id }, data: lease });
		}
		if (e.sceneState !== "STORING" || !e.sceneProviderEvidence)
			throw new Error("VIDEO_TEMPLATE_SCENE_RESULT_REQUIRED");
		const id = randomUUID();
		const root = `users/${e.job.ownerId}/video-templates/${jobId}/${id}`;
		const asset = await tx.mediaAsset.create({
			data: {
				id,
				...lease,
				ownerType: e.job.ownerType,
				ownerId: e.job.ownerId,
				kind: "INPUT",
				status: "UPLOADING",
				objectKey: `${root}.png`,
				outputStagingObjectKey: `${root}.source`,
				mimeType: "image/png",
				byteSize: 0n,
				verificationEngine: "video-workflow-v1",
				verificationGeneration: 1,
				deleteAfter: new Date(
					Date.now() + Number(json(json(e.templateSnapshot).storage).sceneRetentionSeconds) * 1000,
				),
			},
		});
		await tx.videoTemplateExecution.update({ where: { jobId }, data: { sceneAssetId: id } });
		return asset;
	});
}
export async function recordVideoTemplateSceneAsset(input: {
	jobId: string;
	transferToken: string;
	asset: {
		id: string;
		objectKey: string;
		mimeType: string;
		byteSize: bigint;
		checksum: string;
		width: number;
		height: number;
		storageEtag: string | null;
		storageVersionId: string | null;
	};
}) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		await lockVideoOwnerStorage(tx, input.jobId);
		const e = await lock(tx, input.jobId);
		await lockMediaAssetGenerationBindings([input.asset.id], tx);
		const a = e.sceneAsset;
		if (!a || a.id !== input.asset.id || a.objectKey !== input.asset.objectKey)
			throw new Error("VIDEO_TEMPLATE_SCENE_ASSET_CONFLICT");
		if (a.finalizedAt) {
			if (
				a.checksum !== input.asset.checksum ||
				a.storageEtag !== input.asset.storageEtag ||
				a.storageVersionId !== input.asset.storageVersionId ||
				a.byteSize !== input.asset.byteSize
			)
				throw new Error("VIDEO_TEMPLATE_SCENE_IDENTITY_CHANGED");
			return a;
		}
		active(e);
		if (
			a.outputTransferToken !== input.transferToken ||
			!a.outputTransferLeaseExpiresAt ||
			a.outputTransferLeaseExpiresAt <= new Date()
		)
			throw new Error("VIDEO_TEMPLATE_SCENE_TRANSFER_LEASE_LOST");
		if (
			input.asset.byteSize <= 0n ||
			input.asset.byteSize > BigInt(Number(json(json(e.templateSnapshot).scene).maxOutputBytes)) ||
			!/^([a-f0-9]{64})$/i.test(input.asset.checksum) ||
			!input.asset.storageEtag ||
			input.asset.mimeType !== "image/png" ||
			input.asset.width < 1 ||
			input.asset.height < 1
		)
			throw new Error("VIDEO_TEMPLATE_SCENE_ASSET_INVALID");
		const updated = await tx.mediaAsset.update({
			where: { id: a.id },
			data: {
				...input.asset,
				status: "VERIFYING",
				finalizedAt: new Date(),
				outputTransferToken: null,
				outputTransferLeaseExpiresAt: null,
			},
		});
		await tx.videoTemplateExecution.update({
			where: { jobId: input.jobId },
			data: { stageData: { ...json(e.stageData), sceneStoredAt: new Date().toISOString() } },
		});
		return updated;
	});
}
/** Resolve a reviewed user subject without creating a synthetic scene or exposing the reference. */
export async function finalizeVideoTemplateReferenceInput(jobId: string) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const e = await lock(tx, jobId);
		if (!isVideoTemplateReference(e.templateSnapshot))
			throw new Error("VIDEO_TEMPLATE_REFERENCE_INVALID");
		if (e.resolvedInputIdentity) return e.resolvedInputIdentity;
		active(e);
		assertVideoTemplateRoleIdentities(e.job);
		const identities = e.orderedRoleIdentities as Prisma.JsonArray;
		const left = json(identities[0]);
		const right = json(identities[1]);
		if (left.assetId !== right.assetId)
			throw new Error("VIDEO_TEMPLATE_REFERENCE_SUBJECT_REQUIRED");
		await lockMediaAssetGenerationBindings([text(left.assetId)], tx);
		await findApprovedVideoTemplateMotionReference(e.templateSnapshot, tx, new Date());
		const a = e.job.assets.find((binding) => binding.assetId === left.assetId)?.asset;
		const review = json(e.inputReview);
		const profile = readVideoTextSafetyProfile(e.job.inputSnapshot);
		const motionIdentity = json(review.motionTextDecisionIdentity);
		const template = json(e.templateSnapshot);
		const fingerprint = json(e.job.inputSnapshot).requestFingerprint;
		if (
			!a ||
			!["VERIFYING", "READY"].includes(a.status) ||
			!a.checksum ||
			e.sceneAssetId ||
			e.submittedAt ||
			review.status !== "ALLOW" ||
			review.requestFingerprint !== fingerprint ||
			!videoTextSafetyProfilesMatch(review.textSafetyProfile, profile) ||
			!isApprovedVideoTextDecision(review.motionTextDecision, profile) ||
			motionIdentity.requestFingerprint !== fingerprint ||
			motionIdentity.promptVersion !== json(template.video).promptVersion ||
			motionIdentity.promptHash !==
				createHash("sha256")
					.update(text(json(template.video).prompt))
					.digest("hex")
		)
			throw new Error("VIDEO_TEMPLATE_REFERENCE_INPUT_REVIEW_REQUIRED");
		for (const identityValue of identities) {
			const identity = json(identityValue);
			const r = json(review[text(identity.role)]);
			if (
				json(r.decision).decision !== "ALLOW" ||
				r.assetId !== identity.assetId ||
				r.checksum !== identity.checksum ||
				r.objectKey !== identity.objectKey ||
				r.storageEtag !== identity.storageEtag ||
				r.storageVersionId !== identity.storageVersionId ||
				r.verificationGeneration !== identity.verificationGeneration ||
				r.safetyPolicyVersion !== template.safetyPolicyVersion ||
				!text(r.ruleVersion) ||
				typeof r.validUntil !== "string" ||
				!Number.isFinite(Date.parse(r.validUntil)) ||
				Date.parse(r.validUntil) <= Date.now()
			)
				throw new Error("VIDEO_TEMPLATE_REFERENCE_INPUT_REVIEW_REQUIRED");
		}
		const r = json(review.left);
		const validUntil = new Date(
			Math.min(Date.parse(text(r.validUntil)), Date.parse(text(json(review.right).validUntil))),
		);
		const providerTaskId = typeof r.taskId === "string" ? r.taskId : null;
		const attemptNumber = a.verificationAttemptCount + 1;
		await tx.assetModerationResult.create({
			data: {
				assetId: a.id,
				assetChecksum: a.checksum,
				verificationGeneration: a.verificationGeneration,
				attemptNumber,
				evidenceKind: "INPUT",
				provider: "seeapi",
				providerTaskId,
				ruleVersion: text(r.ruleVersion),
				policyVersion: text(template.safetyPolicyVersion),
				status: "APPROVED",
				reasonCode: "VIDEO_TEMPLATE_REFERENCE_SUBJECT_ALLOWED",
				categories: {},
				rawEnvelope: r,
				validUntil,
			},
		});
		await tx.mediaAsset.update({
			where: { id: a.id },
			data: {
				status: "READY",
				verificationProvider: "seeapi",
				verificationProviderTaskId: providerTaskId,
				verificationRuleVersion: text(r.ruleVersion),
				verificationPolicyVersion: text(template.safetyPolicyVersion),
				verificationAttemptCount: attemptNumber,
				verificationValidUntil: validUntil,
			},
		});
		const identity = {
			source: "subject-reference",
			parentRequestFingerprint: fingerprint,
			sourceReviewEvidence: review,
			assetId: a.id,
			checksum: a.checksum,
			objectKey: a.objectKey,
			storageEtag: a.storageEtag,
			storageVersionId: a.storageVersionId,
			verificationGeneration: a.verificationGeneration,
		};
		await tx.videoTemplateExecution.update({
			where: { jobId },
			data: {
				resolvedInputIdentity: identity,
				sceneState: "READY",
				resolvedAt: new Date(),
				stageData: { ...json(e.stageData), resolvedVideoInputSealedAt: new Date().toISOString() },
			},
		});
		return identity;
	});
}

export async function sealVideoTemplateResolvedInput(jobId: string) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const e = await lock(tx, jobId);
		if (e.resolvedInputIdentity) return e.resolvedInputIdentity;
		active(e);
		const a = e.sceneAsset;
		const review = json(e.sceneReview);
		const r = json(review.scene);
		if (
			!a ||
			!a.finalizedAt ||
			!a.checksum ||
			review.status !== "ALLOW" ||
			json(r.decision).decision !== "ALLOW" ||
			r.assetId !== a.id ||
			r.checksum !== a.checksum ||
			r.objectKey !== a.objectKey ||
			r.storageEtag !== a.storageEtag ||
			r.storageVersionId !== a.storageVersionId ||
			r.verificationGeneration !== a.verificationGeneration ||
			r.safetyPolicyVersion !== json(e.templateSnapshot).safetyPolicyVersion ||
			typeof r.validUntil !== "string" ||
			!Number.isFinite(Date.parse(r.validUntil)) ||
			Date.parse(r.validUntil) <= Date.now() ||
			a.deletedAt ||
			a.status === "QUARANTINED"
		)
			throw new Error("VIDEO_TEMPLATE_SCENE_REVIEW_REQUIRED");
		const identity = {
			parentRequestFingerprint: json(e.job.inputSnapshot).requestFingerprint,
			sceneReviewEvidence: review,
			assetId: a.id,
			checksum: a.checksum,
			objectKey: a.objectKey,
			storageEtag: a.storageEtag,
			storageVersionId: a.storageVersionId,
			verificationGeneration: a.verificationGeneration,
		};
		const ruleVersion = text(r.ruleVersion);
		if (!ruleVersion) throw new Error("VIDEO_TEMPLATE_SCENE_REVIEW_REQUIRED");
		const policyVersion = text(json(e.templateSnapshot).safetyPolicyVersion);
		const validUntil = new Date(String(r.validUntil));
		const providerTaskId = typeof r.taskId === "string" ? r.taskId : null;
		await tx.assetModerationResult.create({
			data: {
				assetId: a.id,
				assetChecksum: a.checksum,
				verificationGeneration: a.verificationGeneration,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "seeapi",
				providerTaskId,
				ruleVersion,
				policyVersion,
				status: "APPROVED",
				reasonCode: "VIDEO_TEMPLATE_SCENE_ALLOWED",
				categories: {},
				rawEnvelope: r,
				validUntil,
			},
		});
		await tx.mediaAsset.update({
			where: { id: a.id },
			data: {
				status: "READY",
				verificationProvider: "seeapi",
				verificationProviderTaskId: providerTaskId,
				verificationRuleVersion: ruleVersion,
				verificationPolicyVersion: policyVersion,
				verificationAttemptCount: 1,
				verificationValidUntil: validUntil,
			},
		});
		await tx.videoTemplateExecution.update({
			where: { jobId },
			data: {
				resolvedInputIdentity: identity,
				sceneState: "READY",
				resolvedAt: new Date(),
				stageData: { ...json(e.stageData), resolvedVideoInputSealedAt: new Date().toISOString() },
			},
		});
		return identity;
	});
}
export async function markVideoTemplateNeedsReview(jobId: string, reason: string) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const e = await lock(tx, jobId);
		if (["READY", "FAILED", "REJECTED"].includes(e.job.videoExecution?.stage ?? "")) return;
		await tx.videoTemplateExecution.update({
			where: { jobId },
			data: { sceneState: "NEEDS_REVIEW", stageData: { ...json(e.stageData), reason } },
		});
		await tx.videoExecution.update({
			where: { jobId },
			data: { stage: "NEEDS_REVIEW", needsReviewReason: reason, stateVersion: { increment: 1 } },
		});
		await recordVideoTemplateBusinessEvent(tx, {
			jobId,
			event: "held",
			templateSnapshot: e.templateSnapshot,
		});
		await tx.generationJob.update({
			where: { id: jobId },
			data: { status: "NEEDS_RECONCILIATION", version: { increment: 1 } },
		});
	});
}
export async function markVideoTemplateSceneFailed(
	jobId: string,
	reasonCode: string,
	definitelyNotAccepted = false,
) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const e = await lock(tx, jobId);
		if (e.resolvedInputIdentity) throw new Error("VIDEO_TEMPLATE_SCENE_ALREADY_SEALED");
		if (
			e.submittedAt &&
			!(
				(definitelyNotAccepted && !e.sceneProviderTaskId) ||
				["FAILED", "SUCCEEDED"].includes(text(json(e.sceneProviderEvidence).status))
			)
		)
			throw new Error("VIDEO_UNCERTAIN_RESERVATION_MUST_REMAIN");
		await tx.videoTemplateExecution.update({
			where: { jobId },
			data: {
				sceneState: "FAILED",
				sceneSubmissionUncertain: false,
				stageData: { ...json(e.stageData), reasonCode },
			},
		});
	});
}
export async function persistVideoTemplateSceneWebhook(input: {
	callbackTokenHash: string;
	taskId: string;
	timestamp: string;
	receivedAt: Date;
}) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const found = await tx.videoTemplateExecution.findUnique({
			where: { sceneCallbackTokenHash: input.callbackTokenHash },
		});
		if (!found) throw new Error("VIDEO_TEMPLATE_CALLBACK_INVALID");
		const e = await lock(tx, found.jobId);
		if (!e.submittedAt || (e.sceneProviderTaskId && e.sceneProviderTaskId !== input.taskId))
			throw new Error("VIDEO_TEMPLATE_SCENE_TASK_CONFLICT");
		const provider = "kie-video-template-scene";
		const providerEventId = `${e.jobId}:${input.taskId}:${input.timestamp}`;
		const prior = await tx.providerWebhookEvent.findUnique({
			where: { provider_providerEventId: { provider, providerEventId } },
		});
		if (!e.sceneProviderTaskId)
			await tx.videoTemplateExecution.update({
				where: { jobId: e.jobId },
				data: {
					sceneProviderTaskId: input.taskId,
					sceneSubmissionUncertain: false,
					sceneState: "GENERATING",
					acceptedAt: input.receivedAt,
				},
			});
		const event =
			prior ??
			(await tx.providerWebhookEvent.create({
				data: {
					provider,
					providerEventId,
					providerTaskId: input.taskId,
					verifiedAt: input.receivedAt,
					receivedAt: input.receivedAt,
					envelope: {
						jobId: e.jobId,
						taskId: input.taskId,
						workflowInstanceId: e.job.videoExecution!.workflowInstanceId,
						notifiedAt: null,
					},
				},
			}));
		return {
			eventId: event.id,
			jobId: e.jobId,
			workflowInstanceId: e.job.videoExecution!.workflowInstanceId,
			replayed: !!prior,
			notified: typeof json(event.envelope).notifiedAt === "string",
		};
	});
}
export async function markVideoTemplateSceneWebhookNotified(eventId: string) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const e = await tx.providerWebhookEvent.findFirst({
			where: { id: eventId, provider: "kie-video-template-scene" },
		});
		if (!e) return;
		await tx.providerWebhookEvent.update({
			where: { id: eventId },
			data: {
				status: "PROCESSED",
				processedAt: new Date(),
				envelope: { ...json(e.envelope), notifiedAt: new Date().toISOString() },
			},
		});
	});
}
