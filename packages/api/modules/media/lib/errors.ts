import { ORPCError } from "@orpc/server";

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
	"CONTENT_NOT_ALLOWED",
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
	return new ORPCError(status, { message: code, data: { code } });
}

export function stableMediaErrorCode(error: unknown): MediaErrorCode {
	const message = error instanceof Error ? error.message : "";
	if (/TEXT_MODERATION_(REJECT|REVIEW)/.test(message)) return "CONTENT_NOT_ALLOWED";
	for (const code of MEDIA_ERROR_CODES) {
		if (message.includes(code)) return code;
	}
	if (/credit/i.test(message)) return "INSUFFICIENT_CREDITS";
	if (/asset/i.test(message)) return "ASSET_NOT_READY";
	if (/quote.*expired/i.test(message)) return "QUOTE_EXPIRED";
	return "PROVIDER_UNAVAILABLE";
}
