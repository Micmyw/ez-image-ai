import { listImageEditSessionsForOwner } from "@repo/database";
import { db } from "@repo/database/client";

import { protectedProcedure } from "../../../orpc/procedures";
import { cursorInputSchema, decodeEditSessionCursor, encodeEditSessionCursor } from "../types";

export const listEditSessions = protectedProcedure
	.route({ method: "GET", path: "/media/edit-sessions", tags: ["Media"] })
	.input(cursorInputSchema)
	.handler(async ({ context: { user }, input }) => {
		const result = await listImageEditSessionsForOwner(
			{
				ownerType: "USER",
				ownerId: user.id,
				take: input.limit,
				cursor: decodeEditSessionCursor(input.cursor),
			},
			db,
		);
		const last = result.items[result.items.length - 1];
		return {
			items: result.items.map((session) => ({
				id: session.id,
				rootAssetId: session.rootAssetId,
				title: session.title,
				versionCount: session._count.jobs,
				createdAt: session.createdAt.toISOString(),
				updatedAt: session.updatedAt.toISOString(),
			})),
			nextCursor:
				result.hasMore && last
					? encodeEditSessionCursor({ updatedAt: last.updatedAt, id: last.id })
					: null,
		};
	});
