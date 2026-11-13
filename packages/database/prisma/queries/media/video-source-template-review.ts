import { videoVisualSafetyProfileSchema } from "@repo/config/video-safety";
import {
	isProviderOwnedSourceTemplate,
	isSourceTemplateNoPromptReview,
	readSourceTemplateInternalRequest,
	sourceTemplateIdentitySchema,
	sourceTemplateRoleSchema,
	sourceTemplateSnapshotSchema,
} from "@repo/config/video-template-execution.server";
import {
	isApprovedVideoTextDecision,
	readVideoTextSafetyProfile,
	videoTextSafetyProfilesMatch,
} from "@repo/config/video-text-safety";
import { VIDEO_V1_RULE_VERSION } from "@repo/config/video-v1";

import { getDatabaseClient } from "../../client";
import type { Prisma } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { isSourceTemplateAdministratorApproval } from "./source-template-material-import";
import { runReadCommitted } from "./types";
import { hasVideoApproval } from "./video-v1-fulfillment";

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const identityKeys = [
	"assetId",
	"checksum",
	"objectKey",
	"storageEtag",
	"storageVersionId",
	"verificationGeneration",
] as const;
const terminal = new Set(["READY", "FAILED", "REJECTED", "NEEDS_REVIEW"]);
const roleIdentitySchema = sourceTemplateIdentitySchema.extend({ role: sourceTemplateRoleSchema });

export function readSourceTemplateRoleIdentities(snapshot: unknown) {
	const request = readSourceTemplateInternalRequest(snapshot);
	const identities = roleIdentitySchema.array().max(3).parse(object(snapshot).roleInputIdentities);
	if (
		identities.length !== request.sourceTemplate.request.inputs.length ||
		identities.some((identity, index) => {
			const input = request.sourceTemplate.request.inputs[index];
			return identity.role !== input?.role || identity.assetId !== input?.assetId;
		}) ||
		(identities.length > 0
			? identityKeys.some(
					(key) => identities[0]?.[key] !== object(object(snapshot).inputIdentity)[key],
				)
			: request.mode !== "text-to-video" || object(snapshot).inputIdentity != null)
	)
		throw new Error("VIDEO_SOURCE_TEMPLATE_IDENTITIES_INVALID");
	return identities;
}

type InputJob = {
	ownerType: string;
	ownerId: string;
	inputSnapshot: unknown;
	assets: Array<{
		role: string;
		assetId: string;
		assetChecksum: string;
		asset: {
			ownerType: string;
			ownerId: string;
			status: string;
			deletedAt: Date | null;
			finalizedAt: Date | null;
			deleteAfter: Date | null;
			checksum: string | null;
			objectKey: string;
			storageEtag: string | null;
			storageVersionId: string | null;
			verificationGeneration: number;
		};
	}>;
};

/** All roles are bound to the user; administrator reference assets are a separate contract. */
export function assertSourceTemplateInputIdentities(job: InputJob, now = new Date()) {
	const identities = readSourceTemplateRoleIdentities(job.inputSnapshot);
	for (const identity of identities) {
		const binding = job.assets.find(
			(item) => item.role === "INPUT" && item.assetId === identity.assetId,
		);
		const asset = binding?.asset;
		if (
			!asset ||
			asset.ownerType !== job.ownerType ||
			asset.ownerId !== job.ownerId ||
			asset.deletedAt ||
			!asset.finalizedAt ||
			["DELETED", "QUARANTINED"].includes(asset.status) ||
			binding.assetChecksum !== identity.checksum ||
			identityKeys.some((key) => key !== "assetId" && asset[key] !== identity[key]) ||
			(asset.deleteAfter && asset.deleteAfter <= now)
		)
			throw new Error("VIDEO_INPUT_IDENTITY_CHANGED");
	}
	return identities;
}

/** Publication-time validation of built-in materials. Runtime consumes the published snapshot. */
export async function findApprovedSourceTemplateReferences(
	template: unknown,
	tx: Prisma.TransactionClient,
	now: Date,
	targetEnvironment?: "local" | "staging" | "production",
) {
	const source = sourceTemplateSnapshotSchema.parse(template);
	await lockMediaAssetGenerationBindings(
		source.references.map((reference) => reference.assetId),
		tx,
	);
	const assets = [];
	for (const reference of source.references) {
		const asset = await tx.mediaAsset.findFirst({ where: { id: reference.assetId } });
		if (
			!asset ||
			asset.ownerType !== "USER" ||
			asset.ownerId !== reference.ownerId ||
			asset.status !== "READY" ||
			!asset.finalizedAt ||
			asset.deletedAt ||
			(asset.deleteAfter && asset.deleteAfter <= now) ||
			identityKeys.some((key) => key !== "assetId" && asset[key] !== reference[key]) ||
			Date.parse(reference.validUntil) <= now.getTime() ||
			!asset.verificationValidUntil ||
			asset.verificationValidUntil <= now ||
			!asset.verificationPolicyVersion ||
			!asset.verificationRuleVersion
		)
			throw new Error("VIDEO_SOURCE_TEMPLATE_REFERENCE_IDENTITY_CHANGED");
		if (
			!(await tx.user.findFirst({
				where: { id: reference.ownerId, role: "admin" },
				select: { id: true },
			}))
		)
			throw new Error("VIDEO_SOURCE_TEMPLATE_REFERENCE_OWNER_NOT_AUTHORIZED");
		const evidence = await tx.assetModerationResult.findFirst({
			where: {
				assetId: asset.id,
				assetChecksum: reference.checksum,
				verificationGeneration: reference.verificationGeneration,
				attemptNumber: asset.verificationAttemptCount,
				evidenceKind: asset.kind,
				provider: asset.verificationProvider ?? "",
				providerTaskId: asset.verificationProviderTaskId,
				policyVersion: asset.verificationPolicyVersion,
				ruleVersion: asset.verificationRuleVersion,
				status: "APPROVED",
				validUntil: asset.verificationValidUntil,
			},
		});
		const raw = object(evidence?.rawEnvelope);
		const approval = object(raw.sourceTemplateReferenceApproval);
		const audio = asset.mimeType.startsWith("audio/");
		const administratorImage =
			!audio &&
			asset.verificationProvider === "administrator" &&
			asset.verificationProviderTaskId === null &&
			isSourceTemplateAdministratorApproval(approval, {
				templateKey: source.templateKey,
				version: source.version,
				reference,
				mimeType: asset.mimeType,
				now,
				targetEnvironment,
			});
		if (
			!evidence ||
			!evidence.validUntil ||
			evidence.validUntil <= now ||
			approval.templateKey !== source.templateKey ||
			approval.version !== source.version ||
			approval.sourceUrl !== reference.sourceUrl ||
			approval.rightsEvidence !== reference.rightsEvidence ||
			approval.validUntil !== reference.validUntil ||
			approval.decision !== "ALLOW" ||
			approval.reviewerId !== reference.ownerId ||
			typeof approval.reviewedAt !== "string" ||
			!Number.isFinite(Date.parse(approval.reviewedAt)) ||
			Date.parse(approval.reviewedAt) > now.getTime() ||
			identityKeys.some((key) => approval[key] !== reference[key]) ||
			approval.reviewKind !==
				(audio ? "administrator-audio" : administratorImage ? "administrator-image" : "visual")
		)
			throw new Error("VIDEO_SOURCE_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
		if (audio) {
			if (
				asset.verificationProvider !== "administrator" ||
				((approval.sourceProvenance !== undefined || approval.approvalKind !== undefined) &&
					(asset.verificationProviderTaskId !== null ||
						!isSourceTemplateAdministratorApproval(approval, {
							templateKey: source.templateKey,
							version: source.version,
							reference,
							mimeType: asset.mimeType,
							now,
							targetEnvironment,
						})))
			)
				throw new Error("VIDEO_SOURCE_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
		} else if (asset.mimeType === "video/mp4") {
			const profile = videoVisualSafetyProfileSchema.safeParse(raw.visualSafetyProfile);
			if (
				!profile.success ||
				profile.data.provider !== "seeapi" ||
				!hasVideoApproval(
					{ ...asset, moderationResults: [evidence] },
					now,
					undefined,
					profile.data,
					{ schemaVersion: 1, mode: "not_requested" },
				)
			)
				throw new Error("VIDEO_SOURCE_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
		} else if (["image/jpeg", "image/png", "image/webp"].includes(asset.mimeType)) {
			const image = object(raw.seeapi);
			if (
				!administratorImage &&
				(asset.verificationProvider !== "seeapi" ||
					!asset.verificationProviderTaskId ||
					image.taskId !== asset.verificationProviderTaskId ||
					image.flagged !== false ||
					!Array.isArray(image.nsfw) ||
					image.nsfw.length ||
					!Array.isArray(image.specialCare) ||
					image.specialCare.length)
			)
				throw new Error("VIDEO_SOURCE_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
		} else throw new Error("VIDEO_SOURCE_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
		assets.push(asset);
	}
	return assets;
}

export function getSourceTemplateReviewContext(
	jobId: string,
	client: Prisma.TransactionClient = getDatabaseClient(),
) {
	return client.generationJob.findFirst({
		where: { id: jobId, executionEngine: "video-workflow-v1" },
		include: {
			videoExecution: true,
			attempts: { select: { id: true }, take: 1 },
			assets: { where: { role: "INPUT" }, include: { asset: true } },
		},
	});
}

export async function lockSourceTemplateReviewContext(tx: Prisma.TransactionClient, jobId: string) {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`video-v1:${jobId}`}, 0))`;
	await tx.$queryRaw`SELECT "id" FROM "generation_job" WHERE "id" = ${jobId} AND "executionEngine" = 'video-workflow-v1' FOR UPDATE`;
	const job = await getSourceTemplateReviewContext(jobId, tx);
	if (!job?.videoExecution) throw new Error("VIDEO_JOB_NOT_FOUND");
	const identities = readSourceTemplateRoleIdentities(job.inputSnapshot);
	await lockMediaAssetGenerationBindings(
		identities.map((identity) => identity.assetId),
		tx,
	);
	// Read again after asset binding locks, since a concurrent deletion may have finished while waiting.
	const fresh = await getSourceTemplateReviewContext(jobId, tx);
	if (!fresh?.videoExecution) throw new Error("VIDEO_JOB_NOT_FOUND");
	const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
	if (!clock || !Number.isFinite(clock.now.getTime()))
		throw new Error("DATABASE_CLOCK_UNAVAILABLE");
	assertSourceTemplateInputIdentities(fresh, clock.now);
	return { job: fresh, now: clock.now, identities };
}

function reviewMatchesIdentity(review: Record<string, unknown>, identity: Record<string, unknown>) {
	return identityKeys.every((key) => review[key] === identity[key]);
}
export function isApprovedSourceTemplateRoleReview(
	review: unknown,
	identity: Record<string, unknown>,
	now: Date,
) {
	const value = object(review);
	const decision = object(value.decision);
	const seeapi = object(object(decision.evidence).seeapi);
	return (
		reviewMatchesIdentity(value, identity) &&
		value.ruleVersion === VIDEO_V1_RULE_VERSION &&
		typeof value.taskId === "string" &&
		value.taskId.length > 0 &&
		value.submissionUncertain === false &&
		decision.decision === "ALLOW" &&
		decision.ruleVersion === VIDEO_V1_RULE_VERSION &&
		seeapi.taskId === value.taskId &&
		seeapi.flagged === false &&
		Array.isArray(seeapi.nsfw) &&
		seeapi.nsfw.length === 0 &&
		Array.isArray(seeapi.specialCare) &&
		seeapi.specialCare.length === 0 &&
		typeof value.validUntil === "string" &&
		Number.isFinite(Date.parse(value.validUntil)) &&
		Date.parse(value.validUntil) > now.getTime()
	);
}

export function assertSourceTemplateInputReview(
	snapshot: unknown,
	reviewValue: unknown,
	now: Date,
) {
	const review = object(reviewValue);
	const roles = object(review.roles);
	const profile = readVideoTextSafetyProfile(snapshot);
	if (
		review.status !== "ALLOW" ||
		review.ruleVersion !== VIDEO_V1_RULE_VERSION ||
		review.requestFingerprint !== object(snapshot).requestFingerprint ||
		!videoTextSafetyProfilesMatch(review.textSafetyProfile, profile) ||
		!(isProviderOwnedSourceTemplate(snapshot)
			? review.textDecision === undefined &&
				isSourceTemplateNoPromptReview(snapshot, review.textReviewNotApplicable)
			: review.textReviewNotApplicable === undefined &&
				isApprovedVideoTextDecision(review.textDecision, profile)) ||
		typeof review.validUntil !== "string" ||
		!Number.isFinite(Date.parse(review.validUntil)) ||
		Date.parse(review.validUntil) <= now.getTime() ||
		readSourceTemplateRoleIdentities(snapshot).some(
			(identity) => !isApprovedSourceTemplateRoleReview(roles[identity.role], identity, now),
		)
	)
		throw new Error("VIDEO_INPUT_REVIEW_REQUIRED");
}

export async function claimSourceTemplateImageReview(
	jobId: string,
	role: string,
	callbackTokenHash?: string,
) {
	if (callbackTokenHash !== undefined && !/^[a-f0-9]{64}$/.test(callbackTokenHash))
		throw new Error("SOURCE_CALLBACK_IDENTITY_INVALID");
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const { job, now, identities } = await lockSourceTemplateReviewContext(tx, jobId);
		if (terminal.has(job.videoExecution!.stage) || job.attempts.length) return false;
		const identity = identities.find((item) => item.role === role);
		if (!identity) throw new Error("VIDEO_SOURCE_TEMPLATE_ROLE_INVALID");
		const data = object(job.videoExecution!.stageData);
		const review = object(data.inputReview);
		const roles = object(review.roles);
		const current = object(roles[role]);
		if (current.submissionUncertain || current.taskId || current.decision) return false;
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stage: "INPUT_REVIEW",
				inputReviewStartedAt: job.videoExecution!.inputReviewStartedAt ?? now,
				lastProgressAt: now,
				stateVersion: { increment: 1 },
				stageData: {
					...data,
					inputReview: {
						...review,
						roles: {
							...roles,
							[role]: {
								...identity,
								ruleVersion: VIDEO_V1_RULE_VERSION,
								submissionUncertain: true,
								...(callbackTokenHash ? { callbackTokenHash } : {}),
								submittedAt: now.toISOString(),
							},
						},
					},
				} as Prisma.InputJsonValue,
			},
		});
		return true;
	});
}

export async function recordSourceTemplateImageReview(
	jobId: string,
	role: string,
	patch: {
		taskId?: string;
		submissionUncertain?: false;
		decision?: unknown;
	},
) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const { job, now, identities } = await lockSourceTemplateReviewContext(tx, jobId);
		if (terminal.has(job.videoExecution!.stage) || job.attempts.length) return false;
		const identity = identities.find((item) => item.role === role);
		if (!identity) throw new Error("VIDEO_SOURCE_TEMPLATE_ROLE_INVALID");
		const data = object(job.videoExecution!.stageData);
		const review = object(data.inputReview);
		const roles = object(review.roles);
		const current = object(roles[role]);
		if (
			!reviewMatchesIdentity(current, identity) ||
			(!current.submissionUncertain && !current.taskId) ||
			(patch.taskId !== undefined &&
				(!patch.taskId || (current.taskId && current.taskId !== patch.taskId))) ||
			(patch.submissionUncertain === false && !patch.taskId && !current.taskId)
		)
			throw new Error("VIDEO_INPUT_REVIEW_IDENTITY_CHANGED");
		const next: Record<string, unknown> = { ...current, ...patch };
		const previous = object(current.decision);
		const decision = object(patch.decision);
		const terminalDecision = (value: Record<string, unknown>) =>
			value.decision === "ALLOW" ||
			value.decision === "REJECT" ||
			(value.decision === "REVIEW" && value.reasonCode !== "IMAGE_PROCESSING");
		if (terminalDecision(previous)) {
			// Preserve original approval lifetime and every rejection against stale retrievals.
			if (
				previous.decision !== "ALLOW" ||
				!terminalDecision(decision) ||
				decision.decision === "ALLOW"
			)
				next.decision = current.decision;
		} else if (decision.decision === "ALLOW")
			next.validUntil = new Date(now.getTime() + 3600_000).toISOString();
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				lastProgressAt: now,
				stateVersion: { increment: 1 },
				stageData: {
					...data,
					inputReview: { ...review, roles: { ...roles, [role]: next } },
				} as Prisma.InputJsonValue,
			},
		});
		return true;
	});
}

export async function recordSourceTemplateInputReview(
	jobId: string,
	patch: Record<string, unknown>,
) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const { job, now, identities } = await lockSourceTemplateReviewContext(tx, jobId);
		if (terminal.has(job.videoExecution!.stage) || job.attempts.length) return false;
		const data = object(job.videoExecution!.stageData);
		const current = object(data.inputReview);
		if (
			patch.roles !== undefined ||
			patch.validUntil !== undefined ||
			(patch.requestFingerprint !== undefined &&
				patch.requestFingerprint !== object(job.inputSnapshot).requestFingerprint)
		)
			throw new Error("VIDEO_INPUT_REVIEW_IDENTITY_CHANGED");
		const review = { ...current, ...patch };
		const priorText = object(current.textDecision);
		if (["REJECT", "REVIEW"].includes(String(priorText.decision)))
			review.textDecision = current.textDecision;
		if (patch.status === "ALLOW") {
			const roles = object(review.roles);
			const expiry = identities.length
				? Math.min(
						...identities.map((identity) =>
							Date.parse(String(object(roles[identity.role]).validUntil)),
						),
					)
				: now.getTime() + 3600_000;
			if (!Number.isFinite(expiry)) throw new Error("VIDEO_INPUT_REVIEW_REQUIRED");
			review.validUntil = new Date(expiry).toISOString();
			assertSourceTemplateInputReview(job.inputSnapshot, review, now);
		}
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stage: "INPUT_REVIEW",
				inputReviewStartedAt: job.videoExecution!.inputReviewStartedAt ?? now,
				...(patch.status === "ALLOW" ? { inputReviewCompletedAt: now } : {}),
				lastProgressAt: now,
				stateVersion: { increment: 1 },
				stageData: { ...data, inputReview: review } as Prisma.InputJsonValue,
			},
		});
		return true;
	});
}
