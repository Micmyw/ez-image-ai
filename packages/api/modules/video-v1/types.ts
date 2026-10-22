import { videoEffectIdSchema } from "@repo/config/video-effects";
import { videoOutputReportSchema } from "@repo/config/video-output-report";
import { videoRetailDisplaySchema } from "@repo/config/video-submission";
import { z } from "zod";

export const videoPublicStateSchema = z
	.object({
		jobId: z.string(),
		stage: z.enum([
			"QUEUED",
			"INPUT_REVIEW",
			"SUBMITTING",
			"SUBMISSION_UNCERTAIN",
			"GENERATING",
			"STORING",
			"OUTPUT_REVIEW",
			"FINALIZING",
			"READY",
			"REJECTED",
			"FAILED",
			"NEEDS_REVIEW",
		]),
		creditState: z.enum(["RESERVED", "SETTLED", "RELEASED"]),
		credits: z.string(),
		pricing: videoRetailDisplaySchema.optional(),
		output: videoOutputReportSchema.optional(),
		canPlay: z.boolean(),
		playback: z
			.object({ url: z.string(), expiresAt: z.string(), ownerId: z.string() })
			.strict()
			.optional(),
		failureCode: z.string().nullable(),
		updatedAt: z.string(),
		effect: z
			.object({ effectId: videoEffectIdSchema, name: z.string(), templateVersion: z.string() })
			.strict()
			.optional(),
	})
	.strict();

export const videoQuoteResultSchema = z
	.object({
		quoteId: z.string(),
		credits: z.string(),
		pricing: videoRetailDisplaySchema.optional(),
		expiresAt: z.string(),
		requestFingerprint: z.string(),
	})
	.strict();

export const videoSubmitResultSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("created"), state: videoPublicStateSchema }).strict(),
	z.object({ kind: z.literal("quote_only"), quote: videoQuoteResultSchema }).strict(),
]);
