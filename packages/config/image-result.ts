import { z } from "zod";

import { kieImageCallbackCompletionSchema } from "./kie-image-callback";

const id = z.string().regex(/^[\w-]{1,128}$/);
// Calendar lifetime of persisted image approval; transport receipts still expire.
export const IMAGE_APPROVAL_NO_TIME_EXPIRY = "9999-12-31T23:59:59.999Z";
/** Server-signed at submission, before the provider knows its task ID. */
export const imageResultContextSchema = z
	.object({
		version: z.literal(1),
		jobId: id,
		ownerId: id,
		attemptId: id,
		providerModelId: z.string().min(1).max(128),
		format: z.enum(["png", "jpeg", "webp", "gif", "svg"]),
		frameCount: z.number().int().min(1).max(200).optional(),
		expiresAt: z.number().int().positive(),
		guest: z.boolean(),
	})
	.strict();
export type ImageResultContext = z.infer<typeof imageResultContextSchema>;

const decisionSchema = z.object({
	decision: z.enum(["ALLOW", "REJECT", "REVIEW", "ERROR"]),
	reasonCode: z.string().min(1).max(128),
	ruleVersion: z.string().min(1).max(128),
	retryAfterMs: z.number().nonnegative().optional(),
	evidence: z
		.object({
			requestId: z.string(),
			models: z.array(z.string()),
			operations: z.number(),
			scores: z.record(z.string(), z.number()),
			seeapi: z
				.object({
					taskId: z.string(),
					flagged: z.boolean(),
					nsfw: z.array(z.string()),
					specialCare: z.array(z.string()),
				})
				.optional(),
			seeapiFailure: z
				.object({
					taskId: z.string(),
					status: z.enum(["failed", "canceled", "refunded", "expired"]),
					code: z.string(),
				})
				.optional(),
		})
		.optional(),
});

const priorReviewSchema = z.object({
	moderationTaskId: z.string(),
	idempotencyKey: z.string(),
	decision: decisionSchema,
});

/** Private transport receipt, never a public API payload or a financial state. */
export const imageResultReceiptSchema = z
	.object({
		context: imageResultContextSchema,
		completion: kieImageCallbackCompletionSchema.extend({
			source: z.enum(["kie-image-success-callback", "kie-authenticated-retrieval"]),
			authentication: z.enum(["kie-hmac-sha256", "kie-api-key"]),
		}),
		assetId: id,
		mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]),
		reviewInput: z.enum(["provider-url", "thumbnail"]),
		policyVersion: z.string().min(1).max(128),
		// Preserve the authenticated invalid-media result when converting a direct URL.
		priorReview: priorReviewSchema.optional(),
		submission: z.object({
			moderationTaskId: z.string().regex(/^[\w-]{1,160}$/),
			status: z.enum(["QUEUED", "RUNNING"]),
			ruleVersion: z.string(),
			idempotency: z.object({
				key: z.string(),
				providerSupported: z.boolean(),
				replayed: z.boolean(),
			}),
			retryAfterMs: z.number().nonnegative().optional(),
			nonterminalState: z.enum(["queued", "processing"]).optional(),
			completedDecision: decisionSchema.optional(),
		}),
		decision: decisionSchema.optional(),
		approvedAt: z.number().int().positive().optional(),
		nextQueryAt: z.number().int().positive(),
		// This is a content digest only when special-format conversion actually read the bytes.
		preparedIdentity: z
			.object({ checksum: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive() })
			.optional(),
	})
	.strict();
export type ImageResultReceipt = z.infer<typeof imageResultReceiptSchema>;

export function isInvalidImageResultMedia(receipt: ImageResultReceipt): boolean {
	const decision = receipt.decision;
	return (
		receipt.reviewInput === "provider-url" &&
		decision?.decision === "ERROR" &&
		decision.ruleVersion === receipt.submission.ruleVersion &&
		decision.evidence?.requestId === receipt.submission.moderationTaskId &&
		decision.evidence.models.includes("nsfw-filter-2") &&
		decision.evidence.seeapiFailure?.taskId === receipt.submission.moderationTaskId &&
		decision.evidence.seeapiFailure.status === "failed" &&
		decision.evidence.seeapiFailure.code === "MEDIA_INVALID"
	);
}

export function imageResultPriorReview(receipt: ImageResultReceipt) {
	const prior = receipt.priorReview;
	return receipt.reviewInput === "thumbnail" &&
		prior &&
		isInvalidImageResultMedia({
			...receipt,
			reviewInput: "provider-url",
			submission: { ...receipt.submission, moderationTaskId: prior.moderationTaskId },
			decision: prior.decision,
		})
		? prior
		: undefined;
}

export function isApprovedImageResult(receipt: ImageResultReceipt, now = Date.now()): boolean {
	const decision = receipt.decision;
	const evidence = decision?.evidence;
	return (
		receipt.context.expiresAt > now &&
		receipt.approvedAt !== undefined &&
		receipt.approvedAt <= now &&
		receipt.approvedAt + 86_400_000 > now &&
		decision?.decision === "ALLOW" &&
		decision.ruleVersion === receipt.submission.ruleVersion &&
		evidence?.requestId === receipt.submission.moderationTaskId &&
		evidence.seeapi?.taskId === receipt.submission.moderationTaskId &&
		evidence.models.includes("nsfw-filter-2") &&
		evidence.seeapi.flagged === false &&
		evidence.seeapi.nsfw.length === 0 &&
		evidence.seeapi.specialCare.length === 0
	);
}

export function isTerminalImageResult(receipt: ImageResultReceipt): boolean {
	return Boolean(
		receipt.decision &&
		(receipt.decision.evidence?.seeapi || receipt.decision.evidence?.seeapiFailure),
	);
}
