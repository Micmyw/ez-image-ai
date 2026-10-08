import {
	videoEffectIdSchema,
	videoEffectDurationSchema,
	videoEffectPricingDisplaySchema,
} from "@repo/config/video-effects";
import { z } from "zod";

export const videoEffectStageSchema = z.enum([
	"PREPARING_PHOTOS",
	"CREATING_SCENE",
	"GENERATING_VIDEO",
	"CHECKING_VIDEO",
	"READY",
	"NEEDS_REVIEW",
	"FAILED",
]);
export const videoEffectStateSchema = z
	.object({
		jobId: z.string(),
		effectId: videoEffectIdSchema,
		name: z.string(),
		presetKey: z.literal("standard"),
		templateVersion: z.string(),
		stage: videoEffectStageSchema,
		creditState: z.enum(["RESERVED", "SETTLED", "RELEASED"]),
		credits: z.string(),
		duration: videoEffectDurationSchema.optional(),
		canPlay: z.boolean(),
		failureCode: z.string().nullable(),
		updatedAt: z.string(),
	})
	.strict();
export const videoEffectQuoteSchema = z
	.object({
		quoteId: z.string(),
		credits: z.string(),
		expiresAt: z.string(),
		pricing: videoEffectPricingDisplaySchema.optional(),
	})
	.strict();
export const videoEffectAccessSchema = z
	.object({
		effectId: videoEffectIdSchema,
		available: z.boolean(),
		accessAllowed: z.boolean(),
		reasons: z.array(z.string()),
		credits: z.string().nullable(),
		pricing: videoEffectPricingDisplaySchema.optional(),
		durationOptions: z
			.array(
				z
					.object({
						duration: videoEffectDurationSchema,
						credits: z.string(),
						pricing: videoEffectPricingDisplaySchema.optional(),
					})
					.strict(),
			)
			.optional(),
		pricingValidUntil: z.string().nullable().optional(),
		creditBalance: z
			.object({ totalCredits: z.string(), eligibleCredits: z.string() })
			.strict()
			.nullable(),
		maxInputBytes: z.number().int().positive(),
	})
	.strict();
export const videoEffectUploadSchema = z
	.object({
		assetId: z.string(),
		sessionId: z.string(),
		method: z.literal("PUT"),
		uploadUrl: z.string(),
		expiresAt: z.string(),
	})
	.strict();
export const videoEffectSealedInputSchema = z
	.object({
		assetId: z.string(),
		status: z.literal("VERIFYING"),
		uploadStatus: z.literal("COMPLETED"),
		moderationStatus: z.literal("PENDING"),
		mimeType: z.string(),
		byteSize: z.string(),
		width: z.number(),
		height: z.number(),
	})
	.strict();
export const videoEffectPlaybackSchema = z
	.object({ url: z.string(), expiresAt: z.string() })
	.strict();

/** Explicit allowlist: opaque provider/task/model identifiers never become template UI text. */
export function publicVideoEffectError(message: string): string {
	if (
		[
			"MOTION_REFERENCE_REQUIRED",
			"MOTION_REFERENCE_INVALID",
			"COST_APPROVAL_REQUIRED",
			"COST_APPROVAL_INVALID",
		].includes(message)
	)
		return message;
	if (["NOT_FOUND", "VIDEO_UPLOAD_NOT_FOUND", "VIDEO_INPUT_NOT_AVAILABLE"].includes(message))
		return "INPUT_OR_JOB_NOT_FOUND";
	if (["VIDEO_ACCESS_DENIED"].includes(message)) return "ACCESS_DENIED";
	if (
		[
			"INSUFFICIENT_CREDITS",
			"INSUFFICIENT_PAID_CREDITS",
			"INSUFFICIENT_PAID_FUNDED_CREDITS",
			"PAID_CREDIT_FUNDING_REQUIRED",
			"PAID_CREDIT_FUNDING_INSUFFICIENT",
		].includes(message)
	)
		return "INSUFFICIENT_ELIGIBLE_CREDITS";
	if (
		/^(VIDEO_)?QUOTE_(EXPIRED|CHANGED|ALREADY_USED|NOT_FOUND)$/.test(message) ||
		[
			"VIDEO_PRICE_CHANGED",
			"PRICE_CHANGED",
			"VIDEO_QUOTE_INPUT_MISMATCH",
			"VIDEO_TEMPLATE_QUOTE_INPUT_MISMATCH",
			"VIDEO_TEMPLATE_VERSION_CHANGED",
			"ASSET_CONTENT_CHANGED",
			"VIDEO_FUNDING_POLICY_CHANGED",
			"VIDEO_SAFETY_PROFILE_CHANGED",
		].includes(message)
	)
		return "QUOTE_EXPIRED_OR_CHANGED";
	if (["IDEMPOTENCY_CONFLICT", "VIDEO_IDEMPOTENCY_CONFLICT"].includes(message))
		return "IDEMPOTENCY_CONFLICT";
	if (
		[
			"INPUT_TOO_LARGE",
			"VIDEO_INPUT_TYPE_UNSUPPORTED",
			"VIDEO_INPUT_NOT_SEALED",
			"VIDEO_INPUT_DIMENSIONS_CHANGED",
		].includes(message)
	)
		return "PHOTO_NOT_SUPPORTED";
	if (
		["STORAGE_LIMIT_EXCEEDED", "STORAGE_QUOTA_EXCEEDED", "UPLOAD_SESSION_LIMIT_EXCEEDED"].includes(
			message,
		)
	)
		return "STORAGE_LIMIT_REACHED";
	if (
		[
			"RATE_LIMITED",
			"RATE_LIMIT_EXCEEDED",
			"VIDEO_OWNER_CONCURRENCY_LIMIT",
			"VIDEO_GLOBAL_CONCURRENCY_LIMIT",
			"VIDEO_PROVIDER_CONCURRENCY_LIMIT",
			"VIDEO_OWNER_BUSY",
			"VIDEO_GLOBAL_BUSY",
			"VIDEO_PROVIDER_BUSY",
		].includes(message)
	)
		return "TRY_AGAIN_LATER";
	return "TEMPLATE_UNAVAILABLE";
}
