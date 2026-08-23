import { ORPCError } from "@orpc/server";
import { db } from "@repo/database/client";

import { protectedProcedure } from "../../../orpc/procedures";
import { jobIdInputSchema } from "../types";

export const cancelGeneration = protectedProcedure
	.route({ method: "POST", path: "/media/jobs/{jobId}/cancel", tags: ["Media"] })
	.input(jobIdInputSchema)
	.handler(async ({ context: { user }, input }) => {
		return db.$transaction(async (tx) => {
			const job = await tx.generationJob.findFirst({
				where: { id: input.jobId, ownerType: "USER", ownerId: user.id },
				select: {
					id: true,
					status: true,
					version: true,
					attempts: {
						where: {
							OR: [
								{ uncertainSubmission: true },
								{ status: { in: ["SUBMISSION_UNCERTAIN", "NEEDS_RECONCILIATION"] } },
							],
						},
						select: { id: true },
						take: 1,
					},
				},
			});
			if (!job) throw new ORPCError("NOT_FOUND");
			if (["SUCCEEDED", "FAILED", "CANCELED"].includes(job.status)) {
				return { id: job.id, status: job.status };
			}
			if (job.status === "NEEDS_RECONCILIATION" || job.attempts.length > 0) {
				throw new ORPCError("CONFLICT", {
					message: "This generation requires provider reconciliation before cancellation",
				});
			}
			if (
				!["RESERVED", "DISPATCH_QUEUED", "PROVIDER_PENDING", "PROVIDER_RUNNING"].includes(
					job.status,
				)
			) {
				throw new ORPCError("CONFLICT", {
					message: "This generation can no longer be canceled safely",
				});
			}
			const canceled = await tx.generationJob.updateMany({
				where: {
					id: job.id,
					version: job.version,
					status: {
						in: ["RESERVED", "DISPATCH_QUEUED", "PROVIDER_PENDING", "PROVIDER_RUNNING"],
					},
					attempts: {
						none: {
							OR: [
								{ uncertainSubmission: true },
								{ status: { in: ["SUBMISSION_UNCERTAIN", "NEEDS_RECONCILIATION"] } },
							],
						},
					},
				},
				data: { status: "CANCELED", version: { increment: 1 }, terminalAt: new Date() },
			});
			if (canceled.count !== 1) {
				const current = await tx.generationJob.findFirst({
					where: { id: job.id, submittedByUserId: user.id },
					select: { id: true, status: true },
				});
				if (current && ["SUCCEEDED", "FAILED", "CANCELED"].includes(current.status)) {
					return current;
				}
				throw new ORPCError("CONFLICT", {
					message: "This generation changed state and cannot be canceled",
				});
			}
			const canceledJob = await tx.generationJob.findUniqueOrThrow({
				where: { id: job.id },
				select: { id: true, status: true, version: true },
			});
			await tx.outboxEvent.create({
				data: {
					eventType: "GENERATION_CANCEL_REQUESTED",
					aggregateType: "GENERATION_JOB",
					aggregateId: job.id,
					dedupeKey: `generation-cancel:${job.id}`,
					payload: { jobId: job.id, version: canceledJob.version },
				},
			});
			return { id: canceledJob.id, status: canceledJob.status };
		});
	});
