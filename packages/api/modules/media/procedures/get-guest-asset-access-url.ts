import { ORPCError } from "@orpc/server";
import { getGuestOwnedResultAssetForAccess } from "@repo/database";
import { db } from "@repo/database/client";
import { createSignedReadUrl } from "@repo/storage";
import { z } from "zod";

import { guestMediaProcedure } from "../guest-procedure";
import { currentMediaAssetVerificationBoundary } from "../lib/asset-authorization";

export const getGuestAssetAccessUrl = guestMediaProcedure
	.route({
		method: "POST",
		path: "/media/guest-generations/{jobId}/assets/{assetId}/access",
		tags: ["Media"],
		summary: "Create a short-lived guest result URL",
		description: "Signs only the exact approved watermarked output before its deletion deadline.",
	})
	.input(
		z
			.object({
				jobId: z.string().min(1).max(256),
				assetId: z.string().min(1).max(256),
				disposition: z.enum(["inline", "attachment"]).default("inline"),
			})
			.strict(),
	)
	.output(
		z
			.object({
				assetId: z.string().min(1),
				expiresIn: z.number().int().positive().max(300),
				url: z.string().url(),
			})
			.strict(),
	)
	.handler(async ({ context, input }) => {
		const now = new Date();
		const asset = await getGuestOwnedResultAssetForAccess(
			{
				ownerId: context.user.id,
				jobId: input.jobId,
				assetId: input.assetId,
				now,
				verification: currentMediaAssetVerificationBoundary(now),
			},
			db,
		);
		if (!asset) throw new ORPCError("NOT_FOUND");
		const expiresIn = accessLifetimeSeconds(asset, now);
		if (expiresIn <= 0) throw new ORPCError("PRECONDITION_FAILED");
		context.responseHeaders?.set("Cache-Control", "no-store");
		return {
			assetId: asset.id,
			expiresIn,
			url: await createSignedReadUrl({
				bucket: "media",
				key: asset.objectKey,
				expiresIn,
				responseContentDisposition:
					input.disposition === "inline" ? "inline" : `attachment; filename="${asset.id}"`,
			}),
		};
	});

function accessLifetimeSeconds(
	asset: { verificationValidUntil: Date; deleteAfter: Date; resultExpiresAt: Date },
	now: Date,
): number {
	return Math.min(
		300,
		Math.floor((asset.verificationValidUntil.getTime() - now.getTime()) / 1_000),
		Math.floor((asset.deleteAfter.getTime() - now.getTime()) / 1_000),
		Math.floor((asset.resultExpiresAt.getTime() - now.getTime()) / 1_000),
	);
}
