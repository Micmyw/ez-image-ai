import { ORPCError } from "@orpc/server";
import { createSignedReadUrl } from "@repo/storage";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { requireReadyOwnedMediaAsset } from "../lib/asset-authorization";

export const getAssetAccessUrl = protectedProcedure
	.route({
		method: "POST",
		path: "/media/assets/{assetId}/access",
		tags: ["Media"],
		summary: "Create a short-lived private asset URL",
	})
	.input(
		z.object({
			assetId: z.string().min(1),
			disposition: z.enum(["inline", "attachment"]).default("inline"),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		const asset = await requireReadyOwnedMediaAsset(input.assetId, user.id);
		const remainingEvidenceSeconds = asset.verificationValidUntil
			? Math.floor((asset.verificationValidUntil.getTime() - Date.now()) / 1_000)
			: 0;
		if (remainingEvidenceSeconds <= 0) throw new ORPCError("PRECONDITION_FAILED");
		const expiresIn = Math.min(300, remainingEvidenceSeconds);
		const disposition =
			input.disposition === "inline"
				? ("inline" as const)
				: (`attachment; filename="${asset.id}"` as const);
		return {
			assetId: asset.id,
			expiresIn,
			url: await createSignedReadUrl({
				bucket: "media",
				key: asset.objectKey,
				expiresIn,
				responseContentDisposition: disposition,
			}),
		};
	});
