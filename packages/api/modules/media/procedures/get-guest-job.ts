import { ORPCError } from "@orpc/server";
import { getGuestJobSnapshot, getRegisteredGuestJobSnapshot } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { guestMediaProcedure } from "../guest-procedure";
import { currentMediaAssetVerificationBoundary } from "../lib/asset-authorization";

const guestJobInputSchema = z.object({ jobId: z.string().min(1).max(256) }).strict();
const guestJobOutputSchema = z
	.object({
		jobId: z.string().min(1),
		stage: z.enum(["WAITING", "EDITING", "FINISHING", "READY", "REJECTED", "FAILED", "EXPIRED"]),
		projectedDispatchAt: z.string().datetime(),
		estimateExpiresAt: z.string().datetime(),
		resultExpiresAt: z.string().datetime(),
		resultAssetId: z.string().min(1).nullable(),
		watermarked: z.boolean(),
		trialConsumed: z.boolean(),
		linkReady: z.boolean(),
	})
	.strict();

export const getGuestJob = guestMediaProcedure
	.route({
		method: "GET",
		path: "/media/guest-generations/{jobId}",
		tags: ["Media"],
		summary: "Poll one guest Standard edit",
		description: "Returns a generic public snapshot only for the current anonymous owner.",
	})
	.input(guestJobInputSchema)
	.output(guestJobOutputSchema)
	.handler(async ({ context, input }) => {
		const now = new Date();
		const snapshot = await getGuestJobSnapshot(
			{
				ownerId: context.user.id,
				jobId: input.jobId,
				now,
				verification: currentMediaAssetVerificationBoundary(now),
			},
			db,
		);
		if (!snapshot) throw new ORPCError("NOT_FOUND");
		context.responseHeaders?.set("Cache-Control", "no-store");
		return serializeGuestJob(snapshot);
	});

export const getGrantedGuestJob = protectedProcedure
	.route({
		method: "GET",
		path: "/media/guest-result-grants/{jobId}",
		tags: ["Media"],
		summary: "Poll one expiry-bounded linked guest result",
		description: "Allows only the exact guest job granted to the current registered user.",
	})
	.input(guestJobInputSchema)
	.output(guestJobOutputSchema)
	.handler(async ({ context, input }) => {
		const now = new Date();
		const snapshot = await getRegisteredGuestJobSnapshot(
			{
				registeredUserId: context.user.id,
				jobId: input.jobId,
				now,
				verification: currentMediaAssetVerificationBoundary(now),
			},
			db,
		);
		if (!snapshot) throw new ORPCError("NOT_FOUND");
		context.responseHeaders?.set("Cache-Control", "no-store");
		return serializeGuestJob(snapshot);
	});

function serializeGuestJob(snapshot: Awaited<ReturnType<typeof getGuestJobSnapshot>>) {
	if (!snapshot) throw new ORPCError("NOT_FOUND");
	return {
		jobId: snapshot.jobId,
		stage: snapshot.stage,
		projectedDispatchAt: snapshot.projectedDispatchAt.toISOString(),
		estimateExpiresAt: snapshot.estimateExpiresAt.toISOString(),
		resultExpiresAt: snapshot.resultExpiresAt.toISOString(),
		resultAssetId: snapshot.resultAssetId,
		watermarked: snapshot.watermarked,
		trialConsumed: snapshot.trialConsumed,
		linkReady: snapshot.linkReady,
	};
}
