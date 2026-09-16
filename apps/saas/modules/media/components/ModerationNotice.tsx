"use client";

import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { useTranslations } from "next-intl";

export function ModerationNotice({
	job,
}: {
	job: {
		status: string;
		failureReason?: string | null;
		moderationBilling?: "WAIVED" | "CHARGED" | null;
		creditsCharged: string;
	};
}) {
	const t = useTranslations("media.status");
	const message =
		job.moderationBilling === "WAIVED"
			? "moderationWaived"
			: job.moderationBilling === "CHARGED"
				? "moderationCharged"
				: job.failureReason === "CONTENT_NOT_ALLOWED"
					? "moderationRejected"
					: job.failureReason === "SAFETY_CHECK_UNAVAILABLE" && job.status === "FAILED"
						? "moderationUnavailable"
						: null;
	if (!message) return null;
	return (
		<Alert className="mt-5" variant="error">
			<AlertDescription>{t(message, { credits: job.creditsCharged })}</AlertDescription>
		</Alert>
	);
}
