import { ORPCError } from "@orpc/server";
import { isImageContentRejection } from "@repo/ai";
import { db } from "@repo/database/client";

import { protectedProcedure } from "../../../orpc/procedures";
import { publicImageGenerationInput } from "../lib/public-generation-input";
import { jobIdInputSchema, jsonBigInt } from "../types";

export const getJob = protectedProcedure
	.route({ method: "GET", path: "/media/jobs/{jobId}", tags: ["Media"] })
	.input(jobIdInputSchema)
	.handler(async ({ context: { user }, input }) => {
		const job = await db.generationJob.findFirst({
			where: { id: input.jobId, ownerType: "USER", ownerId: user.id },
			include: {
				reservation: true,
				_count: {
					select: {
						attempts: {
							where: {
								OR: [
									{ uncertainSubmission: true },
									{
										status: {
											in: ["SUBMISSION_UNCERTAIN", "NEEDS_RECONCILIATION"],
										},
									},
								],
							},
						},
					},
				},
				attempts: {
					orderBy: { attemptNumber: "desc" },
					take: 1,
					select: { progress: true, status: true, uncertainSubmission: true },
				},
				assets: {
					orderBy: [{ role: "asc" }, { position: "asc" }, { id: "asc" }],
					select: {
						role: true,
						position: true,
						asset: {
							include: {
								moderationResults: {
									orderBy: [
										{ verificationGeneration: "desc" },
										{ attemptNumber: "desc" },
										{ createdAt: "desc" },
										{ id: "desc" },
									],
									take: 1,
									select: { status: true, reasonCode: true },
								},
							},
						},
					},
				},
			},
		});
		if (!job) throw new ORPCError("NOT_FOUND");
		const inputAssets = job.assets
			.filter(
				(binding) =>
					binding.role === "INPUT" &&
					binding.asset.ownerType === "USER" &&
					binding.asset.ownerId === user.id &&
					binding.asset.status === "READY" &&
					binding.asset.deletedAt === null,
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
					binding.asset.moderationResults[0]?.status === "APPROVED",
			)
			.map(({ asset }) => assetDto(asset));
		const moderationBilling =
			job.failureCode === "OUTPUT_CONTENT_BLOCKED_WAIVED"
				? ("WAIVED" as const)
				: job.failureCode === "OUTPUT_CONTENT_BLOCKED_CHARGED"
					? ("CHARGED" as const)
					: null;
		const moderationRejected =
			Boolean(moderationBilling) ||
			job.assets.some(
				(binding) =>
					binding.role === "OUTPUT" &&
					binding.asset.ownerType === "USER" &&
					binding.asset.ownerId === user.id &&
					isImageContentRejection(binding.asset.moderationResults[0]),
			);
		const safetyUnavailable = job.assets.some(
			(binding) =>
				binding.role === "OUTPUT" &&
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
		return {
			id: job.id,
			status: job.status,
			version: job.version,
			creditsReserved: jsonBigInt(job.creditsReserved),
			creditsCharged: jsonBigInt(
				job.reservation?.settledAmount ?? job.archivedCreditsCharged ?? 0n,
			),
			creditsReleased: jsonBigInt(
				job.reservation?.releasedAmount ?? job.archivedCreditsReleased ?? 0n,
			),
			productKey: job.productKey,
			input: publicInput,
			skuKey: publicInput?.skuKey ?? null,
			aspectRatio: publicInput?.aspectRatio ?? null,
			progress: attempt?.progress ?? null,
			failureCode: job.failureCode,
			moderationBilling,
			failureReason: moderationRejected
				? ("CONTENT_NOT_ALLOWED" as const)
				: safetyUnavailable
					? ("SAFETY_CHECK_UNAVAILABLE" as const)
					: job.status === "FAILED"
						? ("GENERATION_FAILED" as const)
						: null,
			canCancel,
			createdAt: job.createdAt.toISOString(),
			updatedAt: job.updatedAt.toISOString(),
			inputAssets,
			assets: outputAssets,
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
