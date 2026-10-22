import { ORPCError } from "@orpc/server";

import { TextModerationError } from "./public-moderation-reason";

export const MEDIA_ERROR_CODES = [
	"IMAGE_PASS_INSUFFICIENT",
	"IMAGE_PASS_SELECTION_INVALID",
	"IMAGE_PASS_OUTPUT_COUNT_INVALID",
	"IMAGE_PASS_UNAVAILABLE",
	"GENERATION_FUNDING_CONFLICT",
	"INSUFFICIENT_CREDITS",
	"CREDIT_DEBT_OUTSTANDING",
	"ASSET_NOT_READY",
	"MODEL_DISABLED",
	"RATE_LIMITED",
	"PROVIDER_UNAVAILABLE",
	"MEDIA_REQUEST_CONFLICT",
	"QUOTE_EXPIRED",
	"PRICE_CHANGED",
	"BUDGET_EXCEEDED",
	"STORAGE_QUOTA_EXCEEDED",
	"ENTITLEMENT_REQUIRED",
	"INPUT_TOO_LARGE",
	"CONCURRENT_JOB_LIMIT_REACHED",
	"PROVIDER_CONCURRENT_JOB_LIMIT_REACHED",
	"CONTENT_NOT_ALLOWED",
	"CONTENT_REVIEW_REQUIRED",
	"TEXT_LANGUAGE_UNSUPPORTED",
	"SAFETY_CHECK_UNAVAILABLE",
	"GENERATION_RETRY_IN_PROGRESS",
	"GENERATION_RETRY_FAILED",
	"IDEMPOTENCY_CONFLICT",
	"NOT_FOUND",
	"TEMPORARY_REFERENCE_INVALID",
	"TEMPORARY_REFERENCE_EXPIRED",
	"ACTIVE_UPLOAD_SESSION_LIMIT_EXCEEDED",
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
			: code === "GENERATION_RETRY_IN_PROGRESS" ||
				  code === "IDEMPOTENCY_CONFLICT" ||
				  code === "MEDIA_REQUEST_CONFLICT"
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

function isConfirmedTransactionConflict(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	type AdapterCause = { originalCode?: unknown; kind?: unknown };
	const details = error as {
		code?: unknown;
		cause?: AdapterCause;
		meta?: { driverAdapterError?: { cause?: AdapterCause } };
	};
	if (details.code === "P2034" || details.code === "40001") return true;
	// An explicit transport/unknown transaction outcome overrides an older cause.
	// P2010 is Prisma's raw-query wrapper; adapter errors have no top-level code.
	if (details.code != null && details.code !== "P2010") return false;
	const cause = details.meta?.driverAdapterError?.cause ?? details.cause;
	// Recognize only database rollback markers, never query text or an earlier nested
	// failure behind a transport error. This classification does not authorize replay.
	return cause?.originalCode === "40001" || cause?.kind === "TransactionWriteConflict";
}

export function stableMediaErrorCode(error: unknown): MediaErrorCode {
	if (error instanceof TextModerationError) return error.publicCode;
	if (error instanceof MediaPublicError) return error.publicCode;
	if (isConfirmedTransactionConflict(error)) return "MEDIA_REQUEST_CONFLICT";
	const message = error instanceof Error ? error.message : "";
	if (/TEXT_MODERATION_REJECT/.test(message)) return "CONTENT_NOT_ALLOWED";
	if (/TEXT_MODERATION_REVIEW/.test(message)) return "CONTENT_REVIEW_REQUIRED";
	if (/TEXT_MODERATION_(ERROR|CONFIGURATION_ERROR)/.test(message))
		return "SAFETY_CHECK_UNAVAILABLE";
	for (const code of MEDIA_ERROR_CODES) {
		// Preserve legacy aliases, but require complete capacity and technical codes
		// so unrelated diagnostics cannot become an admission or transaction conflict.
		const exactPublicCode =
			code === "CONCURRENT_JOB_LIMIT_REACHED" ||
			code === "PROVIDER_CONCURRENT_JOB_LIMIT_REACHED" ||
			code === "RATE_LIMITED" ||
			code === "MEDIA_REQUEST_CONFLICT";
		if (exactPublicCode ? message === code : message.includes(code)) return code;
	}
	if (/credit/i.test(message)) return "INSUFFICIENT_CREDITS";
	if (/asset/i.test(message)) return "ASSET_NOT_READY";
	if (/quote.*expired/i.test(message)) return "QUOTE_EXPIRED";
	return "PROVIDER_UNAVAILABLE";
}
