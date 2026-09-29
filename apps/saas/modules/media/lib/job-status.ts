export const JOB_STATUSES = [
	"RESERVED",
	"DISPATCH_QUEUED",
	"SUBMITTING",
	"PROVIDER_PENDING",
	"PROVIDER_RUNNING",
	"NEEDS_RECONCILIATION",
	"FINALIZING",
	"SUCCEEDED",
	"FAILED",
	"CANCELED",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type UserJobStage =
	| "checkingReference"
	| "reserved"
	| "queued"
	| "starting"
	| "creating"
	| "confirming"
	| "finishing"
	| "ready"
	| "failed"
	| "canceled";

interface JobStatusInput {
	inputReferenceState?: string | null;
	status: string;
	progress?: number | null;
	hasReadyOutput?: boolean;
}

interface JobPresentation {
	stage: UserJobStage;
	progress: number | null;
	terminal: boolean;
}

const STAGES: Record<JobStatus, UserJobStage> = {
	RESERVED: "reserved",
	DISPATCH_QUEUED: "queued",
	SUBMITTING: "starting",
	PROVIDER_PENDING: "queued",
	PROVIDER_RUNNING: "creating",
	NEEDS_RECONCILIATION: "confirming",
	FINALIZING: "finishing",
	SUCCEEDED: "ready",
	FAILED: "failed",
	CANCELED: "canceled",
};

export function getJobPresentation(input: JobStatusInput): JobPresentation {
	const status = JOB_STATUSES.includes(input.status as JobStatus)
		? (input.status as JobStatus)
		: "FAILED";
	const stage =
		input.inputReferenceState === "VERIFYING" && ["RESERVED", "DISPATCH_QUEUED"].includes(status)
			? "checkingReference"
			: status === "FINALIZING" && input.hasReadyOutput
				? "ready"
				: STAGES[status];
	const progress =
		status === "PROVIDER_RUNNING" && typeof input.progress === "number"
			? Math.max(0, Math.min(100, Math.round(input.progress)))
			: null;

	return {
		stage,
		progress,
		terminal: status === "SUCCEEDED" || status === "FAILED" || status === "CANCELED",
	};
}

interface JobCredits {
	creditsReserved: string;
	creditsCharged: string;
	creditsReleased: string;
}

export function hasUnsettledJobCredits(credits: JobCredits): boolean {
	return (
		BigInt(credits.creditsCharged) + BigInt(credits.creditsReleased) <
		BigInt(credits.creditsReserved)
	);
}

export function getJobPollingInterval(input: {
	status: string;
	isDocumentVisible: boolean;
	hasReadyOutput?: boolean;
	credits?: JobCredits;
}): number | false {
	if (
		getJobPresentation(input).terminal &&
		(!input.credits || !hasUnsettledJobCredits(input.credits))
	)
		return input.hasReadyOutput ? (input.isDocumentVisible ? 30_000 : 60_000) : false;
	if (input.status === "NEEDS_RECONCILIATION") return 15_000;
	return input.isDocumentVisible ? 2_000 : 15_000;
}

/** A new visibility decision can arrive without changing GenerationJob.version. */
export function reconcileJobSnapshot<
	T extends { id: string; version: number; observedAt?: number },
>(previous: T | undefined, incoming: T): T {
	if (!previous || previous.id !== incoming.id) return incoming;
	if (incoming.version < previous.version) return previous;
	if (
		previous.observedAt !== undefined &&
		incoming.observedAt !== undefined &&
		incoming.observedAt < previous.observedAt
	)
		return previous;
	return incoming;
}
