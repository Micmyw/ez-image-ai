"use client";

import { useTranslations } from "next-intl";

import { hasUnsettledJobCredits } from "../lib/job-status";

export function GenerationFailureNotice({
	job,
}: {
	job: {
		status: string;
		failureReason?: string | null;
		inputReferenceState?: string | null;
		creditsReserved: string;
		creditsCharged: string;
		creditsReleased: string;
	};
}) {
	const t = useTranslations("media.failure");
	if (job.status === "NEEDS_RECONCILIATION")
		return <p className="mt-4 text-sm text-muted-foreground">{t("confirming")}</p>;
	if (
		job.status !== "FAILED" ||
		job.failureReason === "CONTENT_NOT_ALLOWED" ||
		job.failureReason === "SAFETY_CHECK_UNAVAILABLE"
	)
		return null;
	const pending = hasUnsettledJobCredits(job);
	const refunded = !pending && job.creditsCharged === "0";
	const reason =
		job.failureReason === "GENERATION_TIMEOUT"
			? "timeout"
			: job.failureReason === "GENERATION_SERVICE_UNAVAILABLE"
				? "serviceUnavailable"
				: "generic";
	return (
		<div className="mt-4 space-y-2 text-sm text-muted-foreground" aria-live="polite">
			<p>{t(reason)}</p>
			{pending && <p>{t("creditsPending")}</p>}
			{refunded && <p>{t("creditsReturned", { credits: job.creditsReleased })}</p>}
			{refunded && (
				<p>
					{t(
						job.inputReferenceState === "EXPIRED" || job.inputReferenceState === "UNAVAILABLE"
							? "referenceExpired"
							: "retryHint",
					)}
				</p>
			)}
		</div>
	);
}
