"use client";

import { ContentSafetyNotice, type SafetyBillingOutcome } from "./ContentSafetyNotice";

export function ModerationNotice({
	job,
}: {
	job: {
		id?: string;
		status: string;
		failureReason?: string | null;
		moderationReason?: string | null;
		moderationBilling?: "WAIVED" | "CHARGED" | null;
		creditsCharged: string;
	};
}) {
	const blocked = Boolean(job.moderationBilling) || job.failureReason === "CONTENT_NOT_ALLOWED";
	const unavailable = job.failureReason === "SAFETY_CHECK_UNAVAILABLE" && job.status === "FAILED";
	if (!blocked && !unavailable) return null;
	const billing: SafetyBillingOutcome =
		job.moderationBilling === "WAIVED"
			? "waived"
			: job.moderationBilling === "CHARGED"
				? "charged"
				: job.creditsCharged === "0"
					? unavailable
						? "returned"
						: "noCharge"
					: "summary";
	return (
		<ContentSafetyNotice
			className="mt-5"
			stage="output"
			outcome={blocked ? "blocked" : "unavailable"}
			reason={job.moderationReason}
			billing={billing}
			credits={job.creditsCharged}
			jobId={job.id}
		/>
	);
}
