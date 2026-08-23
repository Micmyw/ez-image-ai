import { db } from "@repo/database/client";
import { abortMediaUploadSessionTransaction } from "@repo/database/media-assets";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { requireOwnedUploadSession } from "../lib/asset-authorization";

export const abortUploadSession = protectedProcedure
	.route({
		method: "POST",
		path: "/media/upload-sessions/{sessionId}/abort",
		tags: ["Media"],
		summary: "Abort a private media upload",
	})
	.input(z.object({ sessionId: z.string().min(1) }))
	.handler(async ({ context: { user }, input }) => {
		const session = await requireOwnedUploadSession(input.sessionId, user.id);
		if (session.status === "ABORTED")
			return { assetId: session.assetId, status: "DELETED" as const };
		const asset = await abortMediaUploadSessionTransaction(
			{ sessionId: session.id, ownerId: user.id },
			db,
		);
		return { assetId: asset.id, status: asset.status };
	});
