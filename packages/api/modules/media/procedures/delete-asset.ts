import { db } from "@repo/database/client";
import { markMediaAssetDeletedTransaction } from "@repo/database/media-assets";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { requireOwnedMediaAsset } from "../lib/asset-authorization";

export const deleteAsset = protectedProcedure
	.route({
		method: "DELETE",
		path: "/media/assets/{assetId}",
		tags: ["Media"],
		summary: "Revoke and queue deletion of a private asset",
	})
	.input(z.object({ assetId: z.string().min(1) }))
	.handler(async ({ context: { user }, input }) => {
		const existing = await requireOwnedMediaAsset(input.assetId, user.id);
		if (existing.status === "UPLOADING")
			throw new Error("Upload asset cannot be deleted while active");
		const asset = await markMediaAssetDeletedTransaction(
			{ assetId: input.assetId, ownerId: user.id },
			db,
		);
		return { assetId: asset.id, status: asset.status };
	});
