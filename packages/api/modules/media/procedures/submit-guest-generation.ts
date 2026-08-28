import { promptSchema } from "@repo/ai";
import { z } from "zod";

import { guestMediaProcedure } from "../guest-procedure";
import { submitGuestGenerationForGuest } from "../lib/guest-admission";

const guestJobSnapshotSchema = z
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

export const submitGuestGeneration = guestMediaProcedure
	.route({
		method: "POST",
		path: "/media/guest-generations",
		tags: ["Media"],
		summary: "Submit one sponsored guest Standard edit",
		description: "Atomically admits one bounded guest edit without immediate execution.",
	})
	.input(
		z
			.object({
				capabilityVersion: z.string().min(1).max(128),
				sourceAssetId: z.string().min(1).max(256),
				prompt: promptSchema,
				idempotencyKey: z.string().regex(/^\w[\w.-]{7,127}$/),
				deviceId: z.string().uuid(),
				turnstileToken: z.string().min(1).max(2_048),
			})
			.strict(),
	)
	.output(guestJobSnapshotSchema)
	.handler(async ({ context, input }) => {
		const snapshot = await submitGuestGenerationForGuest(
			{
				ownerId: context.user.id,
				sessionId: context.session.id,
				origin: context.headers.get("origin"),
				headers: context.headers,
			},
			input,
			"default",
		);
		context.responseHeaders?.set("Cache-Control", "no-store");
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
	});
