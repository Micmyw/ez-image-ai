import { ORPCError } from "@orpc/server";
import { getRegisteredGuestResultAssetForAccess } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import {
	currentMediaAssetVerificationBoundary,
	requireReadyOwnedMediaAsset,
} from "../lib/asset-authorization";
import { signAuthorizedAssetReadUrl } from "../lib/asset-read-url";
import { createFlowTiming } from "../lib/flow-timing";

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
	.handler(async ({ context: { user, requestId }, input }) => {
		const timing = createFlowTiming({ requestId, assetId: input.assetId });
		const authorizationStarted = performance.now();
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
		timing.mark("asset.authorization", performance.now() - authorizationStarted);
		return timing.measure("asset.sign", () => signAuthorizedAssetReadUrl(asset, input.disposition));
	});
