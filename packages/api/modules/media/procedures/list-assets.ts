import { db } from "@repo/database/client";

import { protectedProcedure } from "../../../orpc/procedures";
import { decodeCursor, encodeCursor, jsonBigInt, listAssetsInputSchema } from "../types";

export const listAssets = protectedProcedure
	.route({ method: "GET", path: "/media/assets", tags: ["Media"] })
	.input(listAssetsInputSchema)
	.handler(async ({ context: { user }, input }) => {
		const cursor = decodeCursor(input.cursor);
		const rows = await db.mediaAsset.findMany({
			where: {
				ownerType: "USER",
				ownerId: user.id,
				status: "READY",
				deletedAt: null,
				...(input.kind === "image" ? { mimeType: { startsWith: "image/" } } : {}),
				...(input.kind === "video" ? { mimeType: { startsWith: "video/" } } : {}),
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
			include: { jobBindings: { where: { role: "OUTPUT" }, take: 1, select: { jobId: true } } },
			take: input.limit + 1,
		});
		const hasMore = rows.length > input.limit;
		const items = rows.slice(0, input.limit);
		const last = items[items.length - 1];
		return {
			items: items.map((asset) => ({
				id: asset.id,
				kind: asset.kind,
				mimeType: asset.mimeType,
				byteSize: jsonBigInt(asset.byteSize),
				createdAt: asset.createdAt.toISOString(),
				sourceJobId: asset.jobBindings[0]?.jobId ?? null,
			})),
			nextCursor: hasMore && last ? encodeCursor(last) : null,
		};
	});
