import { ORPCError } from "@orpc/server";
import { db } from "@repo/database/client";

import { protectedProcedure } from "../../../orpc/procedures";
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
									orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }],
									take: 1,
									select: { status: true },
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
		const moderationRejected = job.assets.some(
			(binding) =>
				binding.role === "OUTPUT" &&
				binding.asset.ownerType === "USER" &&
				binding.asset.ownerId === user.id &&
				(binding.asset.status === "QUARANTINED" ||
					binding.asset.moderationResults[0]?.status === "REJECTED"),
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
		return {
			id: job.id,
			status: job.status,
			version: job.version,
			creditsReserved: jsonBigInt(job.creditsReserved),
			creditsCharged: jsonBigInt(job.reservation?.settledAmount ?? 0n),
			creditsReleased: jsonBigInt(job.reservation?.releasedAmount ?? 0n),
			productKey: job.productKey,
			input: job.inputSnapshot,
			progress: attempt?.progress ?? null,
			failureCode: job.failureCode,
			failureReason: moderationRejected
				? ("CONTENT_NOT_ALLOWED" as const)
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
