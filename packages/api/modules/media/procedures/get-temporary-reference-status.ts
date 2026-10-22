import { ORPCError } from "@orpc/server";
import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { imageModerationProviderForEnvironment, PUBLIC_MODERATION_REASONS } from "@repo/config";
import { getTemporaryReferenceStatus as readTemporaryReferenceStatus } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { publicImageModerationReason } from "../lib/public-moderation-reason";
import { verifyTemporaryReference } from "../lib/temporary-reference-token";

export const getTemporaryReferenceStatus = protectedProcedure
	.route({
		method: "POST",
		path: "/media/temporary-references/{assetId}/status",
		tags: ["Media"],
		summary: "Read the uploaded reference review status",
		description:
			"Reads the current owner's signed reference without starting a review or generation.",
	})
	.input(z.object({ assetId: z.uuid(), token: z.string().min(1).max(2048) }).strict())
	.output(
		z.object({
			status: z.enum(["NOT_STARTED", "PENDING", "APPROVED", "REJECTED", "UNAVAILABLE"]),
			moderationReason: z.enum(PUBLIC_MODERATION_REASONS).nullable(),
		}),
	)
	.handler(async ({ context, input }) => {
		context.responseHeaders?.set("Cache-Control", "private, no-store");
		context.responseHeaders?.set("X-Robots-Tag", "noindex, nofollow");
		let reference;
		try {
			reference = verifyTemporaryReference(input.token, context.user.id, input.assetId);
		} catch {
			// Forged, expired and other-owner references share the same private boundary.
			throw new ORPCError("NOT_FOUND");
		}
		let provider: string | null = null;
		try {
			provider = imageModerationProviderForEnvironment(process.env);
		} catch {
			// Pre-review may be disabled; valid pure uploads must remain queryable.
		}
		const state = await readTemporaryReferenceStatus(
			{
				ownerId: context.user.id,
				reference,
				verification: {
					provider,
					ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
					policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				},
			},
			db,
		);
		if (!state) throw new ORPCError("NOT_FOUND");
		const moderationReason =
			state.status === "UNAVAILABLE" && state.moderationStatus
				? publicImageModerationReason({
						status: state.moderationStatus,
						reasonCode: state.reasonCode ?? undefined,
					})
				: null;
		return { status: moderationReason ? "REJECTED" : state.status, moderationReason };
	});
