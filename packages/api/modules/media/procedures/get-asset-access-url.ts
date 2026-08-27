import { ORPCError } from "@orpc/server";
import { getRegisteredGuestResultAssetForAccess } from "@repo/database";
import { db } from "@repo/database/client";
import { createSignedReadUrl } from "@repo/storage";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import {
	currentMediaAssetVerificationBoundary,
	requireReadyOwnedMediaAsset,
} from "../lib/asset-authorization";

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
		let asset: {
			id: string;
			objectKey: string;
			verificationValidUntil: Date | null;
			deleteAfter?: Date | null;
			resultExpiresAt?: Date;
		};
		try {
			asset = await requireReadyOwnedMediaAsset(input.assetId, user.id);
		} catch (error) {
			if (!(error instanceof ORPCError) || error.code !== "NOT_FOUND") throw error;
			const authorizationNow = new Date();
			const granted = await getRegisteredGuestResultAssetForAccess(
				{
					registeredUserId: user.id,
					assetId: input.assetId,
					now: authorizationNow,
					verification: currentMediaAssetVerificationBoundary(authorizationNow),
				},
				db,
			);
			if (!granted) throw new ORPCError("NOT_FOUND");
			asset = granted;
		}
		const signingNow = new Date();
		const remainingEvidenceSeconds = asset.verificationValidUntil
			? Math.floor((asset.verificationValidUntil.getTime() - signingNow.getTime()) / 1_000)
			: 0;
		const remainingDeleteSeconds = asset.deleteAfter
			? Math.floor((asset.deleteAfter.getTime() - signingNow.getTime()) / 1_000)
			: 300;
		const remainingResultSeconds = asset.resultExpiresAt
			? Math.floor((asset.resultExpiresAt.getTime() - signingNow.getTime()) / 1_000)
			: 300;
		const expiresIn = Math.min(
			300,
			remainingEvidenceSeconds,
			remainingDeleteSeconds,
			remainingResultSeconds,
		);
		if (expiresIn <= 0) throw new ORPCError("PRECONDITION_FAILED");
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
