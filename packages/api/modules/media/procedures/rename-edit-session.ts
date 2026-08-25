import { ORPCError } from "@orpc/server";
import { renameImageEditSessionForOwner } from "@repo/database";
import { db } from "@repo/database/client";

import { protectedProcedure } from "../../../orpc/procedures";
import { renameEditSessionInputSchema } from "../types";

export const renameEditSession = protectedProcedure
	.route({ method: "PATCH", path: "/media/edit-sessions/{sessionId}", tags: ["Media"] })
	.input(renameEditSessionInputSchema)
	.handler(async ({ context: { user }, input }) => {
		const session = await renameImageEditSessionForOwner(
			{
				ownerType: "USER",
				ownerId: user.id,
				sessionId: input.sessionId,
				title: input.title,
			},
			db,
		);
		if (!session) throw new ORPCError("NOT_FOUND");
		return {
			id: session.id,
			title: session.title,
			updatedAt: session.updatedAt.toISOString(),
		};
	});
