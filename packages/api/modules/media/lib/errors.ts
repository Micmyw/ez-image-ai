import { ORPCError } from "@orpc/server";

import { TextModerationError } from "./public-moderation-reason";

export const MEDIA_ERROR_CODES = [
	"INSUFFICIENT_CREDITS",
	"CREDIT_DEBT_OUTSTANDING",
	"ASSET_NOT_READY",
	"MODEL_DISABLED",
	"RATE_LIMITED",
	"PROVIDER_UNAVAILABLE",
	"QUOTE_EXPIRED",
	"PRICE_CHANGED",
	"BUDGET_EXCEEDED",
	"STORAGE_QUOTA_EXCEEDED",
	"ENTITLEMENT_REQUIRED",
	"INPUT_TOO_LARGE",
	"CONCURRENT_JOB_LIMIT_REACHED",
	"CONTENT_NOT_ALLOWED",
	"CONTENT_REVIEW_REQUIRED",
	"TEXT_LANGUAGE_UNSUPPORTED",
	"SAFETY_CHECK_UNAVAILABLE",
	"GENERATION_RETRY_IN_PROGRESS",
	"GENERATION_RETRY_FAILED",
	"IDEMPOTENCY_CONFLICT",
	"NOT_FOUND",
] as const;

export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];

export class MediaPublicError extends Error {
	constructor(public readonly publicCode: MediaErrorCode) {
		super(publicCode);
		this.name = "MediaPublicError";
	}
}

export function toMediaOrpcError(error: unknown): ORPCError<string, unknown> {
	const code = stableMediaErrorCode(error);
	const status =
		code === "NOT_FOUND"
			? "NOT_FOUND"
			: code === "GENERATION_RETRY_IN_PROGRESS" || code === "IDEMPOTENCY_CONFLICT"
				? "CONFLICT"
				: "BAD_REQUEST";
	return new ORPCError(status, {
		message: code,
		data: {
			code,
			...(code === "CONTENT_NOT_ALLOWED" &&
			error instanceof TextModerationError &&
			error.moderationReason
				? { moderationReason: error.moderationReason }
				: {}),
		},
	});
}

export function stableMediaErrorCode(error: unknown): MediaErrorCode {
	if (error instanceof TextModerationError) return error.publicCode;
	const message = error instanceof Error ? error.message : "";
	if (/TEXT_MODERATION_REJECT/.test(message)) return "CONTENT_NOT_ALLOWED";
	if (/TEXT_MODERATION_REVIEW/.test(message)) return "CONTENT_REVIEW_REQUIRED";
	if (/TEXT_MODERATION_(ERROR|CONFIGURATION_ERROR)/.test(message))
		return "SAFETY_CHECK_UNAVAILABLE";
	for (const code of MEDIA_ERROR_CODES) {
		if (message.includes(code)) return code;
	}
	if (/credit/i.test(message)) return "INSUFFICIENT_CREDITS";
	if (/asset/i.test(message)) return "ASSET_NOT_READY";
	if (/quote.*expired/i.test(message)) return "QUOTE_EXPIRED";
	return "PROVIDER_UNAVAILABLE";
}
