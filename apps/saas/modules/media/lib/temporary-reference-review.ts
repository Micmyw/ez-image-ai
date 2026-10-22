import type { ApiRouterClient } from "@repo/api/orpc/router";

export type TemporaryReferenceReview = Awaited<
	ReturnType<ApiRouterClient["media"]["getTemporaryReferenceStatus"]>
>;

export function isTerminalReferenceStatusError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const value = error as { code?: unknown; message?: unknown };
	return [value.code, value.message].some((code) =>
		["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST"].includes(String(code)),
	);
}

export function temporaryReferenceReviewPresentation(
	data: TemporaryReferenceReview | undefined,
	error: unknown,
) {
	const rejected = data?.status === "REJECTED";
	const unavailable = data?.status === "UNAVAILABLE" || isTerminalReferenceStatusError(error);
	return {
		canSubmit: !rejected && !unavailable,
		safetyMessage: rejected
			? ("blocked" as const)
			: unavailable
				? ("safetyUnavailable" as const)
				: null,
		moderationReason: rejected ? data.moderationReason : null,
		status: rejected
			? ("blocked" as const)
			: unavailable
				? ("unavailable" as const)
				: error
					? ("reviewStatusUnavailable" as const)
					: data?.status === "APPROVED"
						? ("ready" as const)
						: data?.status === "NOT_STARTED"
							? ("uploadedForGeneration" as const)
							: ("checking" as const),
	};
}

export function temporaryReferenceReviewPollingInterval({
	enabled,
	data,
	error,
}: {
	enabled: boolean;
	data?: TemporaryReferenceReview;
	error?: unknown;
}): number | false {
	if (!enabled || isTerminalReferenceStatusError(error) || (data && data.status !== "PENDING"))
		return false;
	return 1_000;
}
