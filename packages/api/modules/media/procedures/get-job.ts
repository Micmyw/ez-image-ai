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
				attempts: { orderBy: { attemptNumber: "desc" }, take: 1, select: { progress: true } },
				assets: {
					where: { role: "OUTPUT", asset: { status: "READY", deletedAt: null } },
					select: { asset: true },
				},
			},
		});
		if (!job) throw new ORPCError("NOT_FOUND");
		return {
			id: job.id,
			status: job.status,
			version: job.version,
			creditsReserved: jsonBigInt(job.creditsReserved),
			creditsCharged: jsonBigInt(job.reservation?.settledAmount ?? 0n),
			creditsReleased: jsonBigInt(job.reservation?.releasedAmount ?? 0n),
			productKey: job.productKey,
			input: job.inputSnapshot,
			progress: job.attempts[0]?.progress ?? null,
			failureCode: job.failureCode,
			createdAt: job.createdAt.toISOString(),
			updatedAt: job.updatedAt.toISOString(),
			assets: job.assets.map(({ asset }) => assetDto(asset)),
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
