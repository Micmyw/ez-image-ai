import type {
	FinalizationDependencies,
	FinalizationFailure,
	JobPayload,
	PersistedCandidate,
} from "../contracts";

const DEFAULT_MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

export async function finalizeMedia(
	payload: JobPayload,
	dependencies: FinalizationDependencies,
): Promise<{
	outcome: "SKIPPED" | "FINALIZED" | "RETRY_SCHEDULED";
	readyOutputs: number;
}> {
	const claim = await dependencies.store.claimFinalization(payload);
	if (!claim) return { outcome: "SKIPPED", readyOutputs: 0 };
	const results: Array<PersistedCandidate & { candidateKey: string }> = [];
	for (const candidate of claim.candidates) {
		const existing = await dependencies.store.findPersistedCandidate(claim.jobId, candidate.key);
		if (existing) {
			results.push({ ...existing, candidateKey: candidate.key });
			continue;
		}
		if (candidate.output.kind === "inline-base64") {
			if (claim.mediaKind !== "image") continue;
			const estimatedBytes = Math.floor((candidate.output.data.length * 3) / 4);
			if (estimatedBytes > (dependencies.maxInlineImageBytes ?? DEFAULT_MAX_INLINE_IMAGE_BYTES)) {
				continue;
			}
		}
		try {
			const result = await dependencies.persistCandidate(claim, candidate);
			results.push({ ...result, candidateKey: candidate.key });
		} catch (error) {
			const failure = finalizationFailure(error);
			if (failure.retryable) {
				await dependencies.store.recordFinalizationRetry(claim, failure);
				return {
					outcome: "RETRY_SCHEDULED",
					readyOutputs: results.filter((result) => result.approved).length,
				};
			}
		}
	}
	await dependencies.store.recordFinalization(claim, results);
	return { outcome: "FINALIZED", readyOutputs: results.filter((result) => result.approved).length };
}

function finalizationFailure(error: unknown): FinalizationFailure {
	const value = error as { code?: unknown; stage?: unknown; retryable?: unknown };
	return {
		code: typeof value.code === "string" ? value.code : "FINALIZATION_RETRYABLE",
		stage: value.stage === "MODERATION" ? "MODERATION" : "TRANSFER",
		retryable: value.retryable !== false,
	};
}
