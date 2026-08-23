export interface RecoverMediaVerificationCandidate {
	assetId: string;
	allowQuarantinedReverification: boolean;
}

export interface RecoverMediaVerificationsDependencies {
	listCandidates(input: { limit: number; now: Date }): Promise<RecoverMediaVerificationCandidate[]>;
	trigger(candidate: RecoverMediaVerificationCandidate): Promise<void>;
}

export async function recoverMediaVerifications(
	input: { limit: number },
	dependencies: RecoverMediaVerificationsDependencies,
): Promise<{ recovered: number }> {
	const limit = Math.min(Math.max(input.limit, 1), 100);
	const candidates = await dependencies.listCandidates({ limit, now: new Date() });
	const results = await Promise.allSettled(
		candidates.slice(0, limit).map((candidate) => dependencies.trigger(candidate)),
	);
	return { recovered: results.filter((result) => result.status === "fulfilled").length };
}
