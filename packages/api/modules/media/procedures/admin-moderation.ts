import { ORPCError } from "@orpc/server";
import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { imageModerationProviderForEnvironment } from "@repo/config";
import {
	acknowledgeModerationIncident,
	applyAdminModerationReview,
	completeAdminTextRecheck,
	getAdminModerationOperations,
	getAdminModerationReviewDetail,
} from "@repo/database";
import { db } from "@repo/database/client";
import { createSignedReadUrl } from "@repo/storage";
import { z } from "zod";

import { adminProcedure } from "../../../orpc/procedures";
import {
	createTextModerationAdapter,
	moderateTextWithRetry,
	TEXT_MODERATION_RULE_VERSION,
	type TextModerationEvidence,
} from "../lib/text-moderation";

const id = z.string().min(1).max(160);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);
const reviewSchema = z.object({
	id,
	targetType: z.enum(["ASSET", "QUOTE", "TEXT_ATTEMPT"]),
	targetId: id,
	provider: z.string().max(80),
	stage: z.enum(["TEXT", "IMAGE"]),
	status: code,
	bypassed: z.boolean(),
	failureCount: z.number().int().nonnegative(),
	lastErrorCode: code,
	firstFailureAt: z.date(),
	lastFailureAt: z.date(),
	updatedAt: z.date(),
	resolvedAt: z.date().nullable(),
	resolutionReason: z.string().nullable(),
	version: z.number().int().nonnegative(),
});
const reason = z.string().trim().min(10).max(500);

const operationsOutputSchema = z.object({
	pendingCount: z.number(),
	openCount: z.number(),
	nextCursor: z.object({ before: z.string().datetime(), beforeId: id }).nullable(),
	incidents: z.array(
		z.object({
			id,
			provider: z.string(),
			stage: z.string(),
			status: code,
			lastErrorCode: code,
			failureCount: z.number(),
			affectedTargets: z.number(),
			firstFailureAt: z.date(),
			lastFailureAt: z.date(),
			recoveredAt: z.date().nullable(),
			acknowledgedAt: z.date().nullable(),
			targets: z.array(z.object({ targetType: z.string(), targetId: id })),
		}),
	),
	reviews: z.array(reviewSchema.extend({ jobIds: z.array(id) })),
});

export const adminModerationOperations = adminProcedure
	.route({ method: "GET", path: "/admin/media/moderation", tags: ["Admin", "Media"] })
	.input(
		z.object({
			limit: z.number().int().min(1).max(100).default(25),
			status: z
				.enum(["PENDING_REVIEW", "RECHECKING", "BLOCKED", "APPROVED", "REJECTED", "RETRYING"])
				.optional(),
			before: z.string().datetime().optional(),
			beforeId: id.optional(),
		}),
	)
	.output(operationsOutputSchema)
	.handler(async ({ input }) =>
		operationsOutputSchema.parse(
			await getAdminModerationOperations(
				{ ...input, before: input.before ? new Date(input.before) : undefined },
				db,
			),
		),
	);

export const adminModerationDetail = adminProcedure
	.route({
		method: "GET",
		path: "/admin/media/moderation/reviews/{reviewId}",
		tags: ["Admin", "Media"],
	})
	.input(z.object({ reviewId: id }))
	.output(
		z.object({
			review: reviewSchema,
			prompt: z.string().nullable(),
			imageUrl: z.string().nullable(),
			uncertainSubmission: z.boolean(),
		}),
	)
	.handler(async ({ input, context: { user } }) => {
		const detail = await getAdminModerationReviewDetail(input.reviewId, user.id, db);
		return {
			review: reviewSchema.parse(detail.review),
			prompt: detail.prompt,
			imageUrl: detail.asset?.mimeType.startsWith("image/")
				? await createSignedReadUrl({ bucket: "media", key: detail.asset.objectKey, expiresIn: 60 })
				: null,
			uncertainSubmission: Boolean(
				detail.asset?.verificationSubmissionUncertain && !detail.asset.verificationProviderTaskId,
			),
		};
	});

export const adminModerationReviewAction = adminProcedure
	.route({
		method: "POST",
		path: "/admin/media/moderation/reviews/{reviewId}/actions",
		tags: ["Admin", "Media"],
	})
	.input(
		z.object({
			reviewId: id,
			version: z.number().int().nonnegative(),
			action: z.enum(["APPROVE", "REJECT", "RECHECK"]),
			reason,
			idempotencyKey: z.string().min(8).max(128),
		}),
	)
	.output(z.object({ reviewId: id, status: code, replayed: z.boolean() }))
	.handler(async ({ input, context: { user } }) => {
		try {
			const result = await applyAdminModerationReview(
				{
					...input,
					actorUserId: user.id,
					verification: {
						provider: imageModerationProviderForEnvironment(process.env),
						ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
						policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
					},
				},
				db,
			);
			if (input.action !== "RECHECK" || result.replayed) return result;
			const detail = await getAdminModerationReviewDetail(input.reviewId, user.id, db);
			if (detail.review.targetType !== "QUOTE") return result;
			const startedAt = new Date().toISOString();
			let moderation: Omit<TextModerationEvidence, "provider" | "inputFingerprint">;
			let provider = detail.review.provider;
			try {
				if (!detail.prompt) throw new Error("MODERATION_REVIEW_TARGET_UNAVAILABLE");
				const selection = createTextModerationAdapter(process.env);
				provider = selection.provider;
				moderation = await moderateTextWithRetry(
					{ text: detail.prompt, ruleVersion: TEXT_MODERATION_RULE_VERSION },
					(value) => selection.adapter.moderateText(value),
				);
			} catch {
				// An adapter/configuration exception remains blocked and leaves a retryable admin task.
				moderation = {
					decision: "ERROR",
					ruleVersion: TEXT_MODERATION_RULE_VERSION,
					reasonCode: "MODERATION_RECHECK_ERROR",
					retry: {
						failures: 1,
						lastErrorCode: "MODERATION_RECHECK_ERROR",
						startedAt,
						lastFailureAt: new Date().toISOString(),
					},
				};
			}
			const completed = await completeAdminTextRecheck(
				{
					reviewId: input.reviewId,
					version: input.version + 1,
					moderation: { ...moderation, provider },
				},
				db,
			);
			return { ...result, status: completed.status };
		} catch (error) {
			const message = error instanceof Error ? error.message : "MODERATION_REVIEW_FAILED";
			if (message === "MODERATION_REVIEW_NOT_FOUND") throw new ORPCError("NOT_FOUND");
			if (/^(MODERATION_|IDEMPOTENCY_CONFLICT)/.test(message))
				throw new ORPCError("CONFLICT", { message });
			throw error;
		}
	});

export const adminModerationAcknowledge = adminProcedure
	.route({
		method: "POST",
		path: "/admin/media/moderation/incidents/{incidentId}/acknowledge",
		tags: ["Admin", "Media"],
	})
	.input(z.object({ incidentId: id, reason }))
	.handler(({ input, context: { user } }) =>
		acknowledgeModerationIncident({ ...input, actorUserId: user.id }, db),
	);
