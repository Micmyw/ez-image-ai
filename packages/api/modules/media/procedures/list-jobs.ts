import { db } from "@repo/database/client";

import { protectedProcedure } from "../../../orpc/procedures";
import { decodeCursor, encodeCursor, jsonBigInt, listJobsInputSchema } from "../types";

export const listJobs = protectedProcedure
	.route({ method: "GET", path: "/media/jobs", tags: ["Media"] })
	.input(listJobsInputSchema)
	.handler(async ({ context: { user }, input }) => {
		const cursor = decodeCursor(input.cursor);
		const rows = await db.generationJob.findMany({
			where: {
				ownerType: "USER",
				ownerId: user.id,
				...(input.productKey ? { productKey: input.productKey } : {}),
				...(input.status === "active"
					? { status: { notIn: ["SUCCEEDED", "FAILED", "CANCELED"] as const } }
					: {}),
				...(input.status === "succeeded" ? { status: "SUCCEEDED" as const } : {}),
				...(input.status === "failed" ? { status: "FAILED" as const } : {}),
				...(input.status === "canceled" ? { status: "CANCELED" as const } : {}),
				...(cursor
					? {
							OR: [
								{ createdAt: { lt: cursor.createdAt } },
								{ createdAt: cursor.createdAt, id: { lt: cursor.id } },
							],
						}
					: {}),
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			include: {
				reservation: true,
				assets: {
					where: { role: "OUTPUT", asset: { status: "READY", deletedAt: null } },
					select: { assetId: true },
				},
			},
			take: input.limit + 1,
		});
		const hasMore = rows.length > input.limit;
		const items = rows.slice(0, input.limit);
		const last = items[items.length - 1];
		return {
			items: items.map((job) => ({
				id: job.id,
				status: job.status,
				version: job.version,
				productKey: job.productKey,
				creditsReserved: jsonBigInt(job.creditsReserved),
				creditsCharged: jsonBigInt(job.reservation?.settledAmount ?? 0n),
				creditsReleased: jsonBigInt(job.reservation?.releasedAmount ?? 0n),
				outputCount: job.assets.length,
				createdAt: job.createdAt.toISOString(),
			})),
			nextCursor: hasMore && last ? encodeCursor(last) : null,
		};
	});
