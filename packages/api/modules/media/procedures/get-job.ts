import { createHash } from "node:crypto";

import { ORPCError } from "@orpc/server";
import { isTechnicalGenerationFailureCode } from "@repo/config";
import { db } from "@repo/database/client";
import { hasCurrentApprovedMediaAssetEvidence } from "@repo/database/media-assets";
import { getOwnedGenerationJobStatus } from "@repo/database/media-job-status";

import { protectedProcedure } from "../../../orpc/procedures";
import { currentMediaAssetVerificationBoundary } from "../lib/asset-authorization";
import { signAuthorizedAssetReadUrl } from "../lib/asset-read-url";
import { createFlowTiming } from "../lib/flow-timing";
import { publicImageGenerationInput } from "../lib/public-generation-input";
import { publicImageModerationReason } from "../lib/public-moderation-reason";
import { jobIdInputSchema, jsonBigInt } from "../types";

export const getJob = protectedProcedure
	.route({ method: "GET", path: "/media/jobs/{jobId}", tags: ["Media"] })
	.input(jobIdInputSchema)
	.handler(async ({ context: { user, requestId, responseHeaders }, input }) => {
		const timing = createFlowTiming({ requestId, jobId: input.jobId });
		responseHeaders?.set("Cache-Control", "private, no-store");
		const observedAt = Date.now();
		const job = await timing.measure("status.query", () =>
			getOwnedGenerationJobStatus(input.jobId, user.id, db),
		);
		if (!job) throw new ORPCError("NOT_FOUND");
		timing.bind({ attemptId: job.attempts[0]?.id });
		const authorizationStarted = performance.now();
		const boundary = currentMediaAssetVerificationBoundary();
		const reference = job.assets.find(
			(binding) =>
				binding.role === "INPUT" &&
				binding.asset.ownerType === "USER" &&
				binding.asset.ownerId === user.id,
		)?.asset;
		const referenceExpired = Boolean(reference?.deleteAfter && reference.deleteAfter <= new Date());
		const inputReferenceState = !reference
			? null
			: referenceExpired
				? ("EXPIRED" as const)
				: reference.status === "VERIFYING"
					? ("VERIFYING" as const)
					: reference.status === "READY"
						? ("READY" as const)
						: ("UNAVAILABLE" as const);
		const inputAssets = job.assets
			.filter(
				(binding) =>
					binding.role === "INPUT" &&
					binding.asset.ownerType === "USER" &&
					binding.asset.ownerId === user.id &&
					binding.asset.status === "READY" &&
					binding.asset.deletedAt === null &&
					(!binding.asset.deleteAfter || binding.asset.deleteAfter > new Date()),
			)
			.map(({ asset }) => assetDto(asset));
		const outputAssets = job.assets
			.filter(
				(binding) =>
					binding.role === "OUTPUT" &&
					binding.asset.ownerType === "USER" &&
					binding.asset.ownerId === user.id &&
					binding.asset.status === "READY" &&
					binding.asset.deletedAt === null &&
					(!binding.asset.deleteAfter || binding.asset.deleteAfter > boundary.now) &&
					hasCurrentApprovedMediaAssetEvidence(binding.asset, boundary),
			)
			.map(({ asset }) => asset);
		const moderationBilling =
			job.failureCode === "OUTPUT_CONTENT_BLOCKED_WAIVED"
				? ("WAIVED" as const)
				: job.failureCode === "OUTPUT_CONTENT_BLOCKED_CHARGED"
					? ("CHARGED" as const)
					: null;
		const rejectedOutput = job.assets.find(
			(binding) =>
				binding.role === "OUTPUT" &&
				binding.asset.ownerType === "USER" &&
				binding.asset.ownerId === user.id &&
				publicImageModerationReason(binding.asset.moderationResults[0]) !== null,
		);
		const rejectedInput =
			reference && publicImageModerationReason(reference.moderationResults[0]) !== null
				? reference
				: null;
		const moderationRejected =
			Boolean(moderationBilling) || Boolean(rejectedOutput) || Boolean(rejectedInput);
		const safetyUnavailable = job.assets.some(
			(binding) =>
				binding.asset.ownerType === "USER" &&
				binding.asset.ownerId === user.id &&
				(binding.asset.status === "VERIFICATION_FAILED" || binding.asset.status === "QUARANTINED"),
		);
		const attempt = job.attempts[0];
		const canCancel =
			["RESERVED", "DISPATCH_QUEUED", "PROVIDER_PENDING", "PROVIDER_RUNNING"].includes(
				job.status,
			) &&
			job._count.attempts === 0 &&
			!attempt?.uncertainSubmission &&
			attempt?.status !== "SUBMISSION_UNCERTAIN" &&
			attempt?.status !== "NEEDS_RECONCILIATION";
		const publicInput = publicImageGenerationInput(job.productKey, job.inputSnapshot);
		const creditsCharged = job.reservation?.settledAmount ?? job.archivedCreditsCharged ?? 0n;
		const creditsReleased = job.reservation?.releasedAmount ?? job.archivedCreditsReleased ?? 0n;
		const canRetry =
			job.status === "FAILED" &&
			!moderationRejected &&
			job._count.attempts === 0 &&
			job.reservation?.status !== "ACTIVE" &&
			creditsCharged + creditsReleased >= job.creditsReserved &&
			Boolean(
				publicInput && (publicInput.kind === "text-to-image" || inputReferenceState === "READY"),
			);
		timing.mark("status.authorization", performance.now() - authorizationStarted);
		const outputs = await timing.measure("status.sign", () =>
			Promise.all(
				outputAssets.map(async (asset) => {
					const contentVersion = createHash("sha256")
						.update(
							JSON.stringify([
								asset.id,
								asset.objectKey,
								asset.checksum,
								asset.verificationGeneration,
							]),
						)
						.digest("hex");
					const visibleUntil = new Date(
						Math.min(
							asset.verificationValidUntil!.getTime(),
							asset.deleteAfter?.getTime() ?? Infinity,
						),
					).toISOString();
					const preview = await signAuthorizedAssetReadUrl(asset);
					timing.mark("status.preview", 0, { assetId: asset.id });
					return { ...assetDto(asset), contentVersion, visibleUntil, preview };
				}),
			),
		);
		const displayVersion = createHash("sha256")
			.update(
				JSON.stringify([
					job.version,
					job.status,
					inputReferenceState,
					creditsCharged.toString(),
					creditsReleased.toString(),
					job.assets.map(({ asset, role }) => [
						role,
						asset.id,
						asset.status,
						asset.updatedAt,
						asset.deletedAt,
						asset.deleteAfter,
						asset.verificationGeneration,
						asset.verificationValidUntil,
						asset.moderationResults[0]?.id,
					]),
					outputs.map((asset) => [asset.id, asset.contentVersion, asset.visibleUntil]),
				]),
			)
			.digest("hex");
		return {
			requestId,
			observedAt,
			displayVersion,
			id: job.id,
			status: job.status,
			version: job.version,
			creditsReserved: jsonBigInt(job.creditsReserved),
			creditsCharged: jsonBigInt(creditsCharged),
			creditsReleased: jsonBigInt(creditsReleased),
			productKey: job.productKey,
			input: publicInput,
			skuKey: publicInput?.skuKey ?? null,
			aspectRatio: publicInput?.aspectRatio ?? null,
			progress: attempt?.progress ?? null,
			failureCode: job.failureCode,
			moderationBilling,
			inputReferenceState,
			moderationStage:
				rejectedInput ||
				(reference && ["QUARANTINED", "VERIFICATION_FAILED"].includes(reference.status))
					? ("input" as const)
					: ("output" as const),
			moderationReason: moderationRejected
				? (publicImageModerationReason(
						rejectedInput?.moderationResults[0] ?? rejectedOutput?.asset.moderationResults[0],
					) ?? "restrictedContent")
				: null,
			failureReason: moderationRejected
				? ("CONTENT_NOT_ALLOWED" as const)
				: safetyUnavailable
					? ("SAFETY_CHECK_UNAVAILABLE" as const)
					: job.status === "FAILED"
						? isTechnicalGenerationFailureCode(job.failureCode)
							? job.failureCode
							: ("GENERATION_FAILED" as const)
						: null,
			canCancel,
			canRetry,
			createdAt: job.createdAt.toISOString(),
			updatedAt: job.updatedAt.toISOString(),
			inputAssets,
			assets: outputs,
		};
	});

function assetDto(asset: {
	id: string;
	kind: string;
	mimeType: string;
	byteSize: bigint;
	width: number | null;
	height: number | null;
	durationMillis: bigint | null;
	createdAt: Date;
	moderationResults?: Array<{ status: string }>;
}) {
	return {
		id: asset.id,
		kind: asset.kind,
		mimeType: asset.mimeType,
		byteSize: jsonBigInt(asset.byteSize),
		width: asset.width,
		height: asset.height,
		durationMillis: asset.durationMillis ? jsonBigInt(asset.durationMillis) : null,
		createdAt: asset.createdAt.toISOString(),
	};
}
