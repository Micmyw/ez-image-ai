export const DEFAULT_FINALIZATION_STALE_AFTER_SECONDS = 300;

export interface FinalizingGenerationRecoveryCandidate {
	jobId: string;
}

export type FinalizingGenerationRecoveryOutcome = "RECOVERED" | "SKIPPED" | "EXHAUSTED";

export interface FinalizingGenerationRecoveryDependencies {
	listCandidates(input: {
		limit: number;
		now: Date;
		staleBefore: Date;
	}): Promise<FinalizingGenerationRecoveryCandidate[]>;
	recoverCandidate(
		candidate: FinalizingGenerationRecoveryCandidate,
		input: { now: Date; staleBefore: Date },
	): Promise<FinalizingGenerationRecoveryOutcome>;
	now?: () => Date;
}

export interface FinalizingGenerationRecoveryResult {
	scanned: number;
	recovered: number;
	skipped: number;
	exhausted: number;
	failed: number;
}

export async function recoverFinalizingGenerations(
	input: { limit: number; staleAfterSeconds?: number },
	dependencies: FinalizingGenerationRecoveryDependencies,
): Promise<FinalizingGenerationRecoveryResult> {
	const limit = boundedInteger(input.limit, 1, 100, 1);
	const staleAfterSeconds = boundedInteger(
		input.staleAfterSeconds ?? DEFAULT_FINALIZATION_STALE_AFTER_SECONDS,
		60,
		86_400,
		DEFAULT_FINALIZATION_STALE_AFTER_SECONDS,
	);
	const now = dependencies.now?.() ?? new Date();
	const staleBefore = new Date(now.getTime() - staleAfterSeconds * 1_000);
	const candidates = (await dependencies.listCandidates({ limit, now, staleBefore })).slice(
		0,
		limit,
	);
	const results = await Promise.allSettled(
		candidates.map((candidate) => dependencies.recoverCandidate(candidate, { now, staleBefore })),
	);
	const summary: FinalizingGenerationRecoveryResult = {
		scanned: candidates.length,
		recovered: 0,
		skipped: 0,
		exhausted: 0,
		failed: 0,
	};
	for (const result of results) {
		if (result.status === "rejected") {
			summary.failed += 1;
			continue;
		}
		if (result.value === "RECOVERED") summary.recovered += 1;
		else if (result.value === "EXHAUSTED") summary.exhausted += 1;
		else summary.skipped += 1;
	}
	return summary;
}

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}
