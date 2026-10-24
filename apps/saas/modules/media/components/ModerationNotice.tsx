"use client";

import { ContentSafetyNotice, type SafetyBillingOutcome } from "./ContentSafetyNotice";

export function ModerationNotice({
	job,
}: {
	job: {
		id?: string;
		status: string;
		fundingSource?: "CREDITS" | "IMAGE_PASS";
		failureReason?: string | null;
		failureCode?: string | null;
		moderationReason?: string | null;
		moderationStage?: "input" | "output";
		moderationBilling?: "WAIVED" | "CHARGED" | null;
		creditsCharged: string;
	};
}) {
	const blocked = Boolean(job.moderationBilling) || job.failureReason === "CONTENT_NOT_ALLOWED";
	const unavailable = job.failureReason === "SAFETY_CHECK_UNAVAILABLE" && job.status === "FAILED";
	if (!blocked && !unavailable) return null;
	const providerRejection = job.failureCode === "PROVIDER_POLICY_REJECTED_CHARGED";
	const billing: SafetyBillingOutcome = providerRejection
		? "providerRejection"
		: job.moderationBilling === "WAIVED"
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
			stage={job.moderationStage ?? "output"}
			outcome={blocked ? "blocked" : "unavailable"}
			reason={job.moderationReason}
			billing={billing}
			fundingSource={job.fundingSource}
			credits={job.creditsCharged}
			jobId={job.id}
			providerRejection={providerRejection}
		/>
	);
}
