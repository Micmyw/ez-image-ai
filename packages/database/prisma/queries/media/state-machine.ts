export const GENERATION_JOB_STATUSES = [
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

export type GenerationJobStatusValue = (typeof GENERATION_JOB_STATUSES)[number];

const ALLOWED_TRANSITIONS: Readonly<
	Record<GenerationJobStatusValue, ReadonlySet<GenerationJobStatusValue>>
> = {
	RESERVED: new Set(["DISPATCH_QUEUED", "FAILED", "CANCELED"]),
	DISPATCH_QUEUED: new Set(["SUBMITTING", "PROVIDER_PENDING", "FAILED", "CANCELED"]),
	SUBMITTING: new Set(["DISPATCH_QUEUED", "PROVIDER_PENDING", "FINALIZING", "FAILED", "CANCELED"]),
	PROVIDER_PENDING: new Set([
		"PROVIDER_RUNNING",
		"NEEDS_RECONCILIATION",
		"FINALIZING",
		"SUCCEEDED",
		"FAILED",
		"CANCELED",
	]),
	PROVIDER_RUNNING: new Set([
		"NEEDS_RECONCILIATION",
		"FINALIZING",
		"SUCCEEDED",
		"FAILED",
		"CANCELED",
	]),
	NEEDS_RECONCILIATION: new Set(["PROVIDER_PENDING", "FINALIZING"]),
	FINALIZING: new Set(["SUCCEEDED", "FAILED", "CANCELED"]),
	SUCCEEDED: new Set(),
	FAILED: new Set(),
	CANCELED: new Set(),
};

export function canTransition(
	from: GenerationJobStatusValue,
	to: GenerationJobStatusValue,
): boolean {
	return ALLOWED_TRANSITIONS[from].has(to);
}
