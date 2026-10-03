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
	outcome: "SKIPPED" | "FINALIZED" | "RETRY_SCHEDULED" | "WAITING_MODERATION";
	readyOutputs: number;
	outputReviewEventIds?: string[];
}> {
	const claim = await dependencies.store.claimFinalization(payload);
	if (!claim) return { outcome: "SKIPPED", readyOutputs: 0 };
	const results: Array<PersistedCandidate & { candidateKey: string }> = [];
	let terminalFailure: FinalizationFailure | undefined;
	let retryFailure: FinalizationFailure | undefined;
	for (const candidate of claim.candidates) {
		const existing = await dependencies.store.findPersistedCandidate(claim.jobId, candidate.key);
		if (existing) {
			results.push({ ...existing, candidateKey: candidate.key });
			continue;
		}
		if (candidate.output.kind === "inline-base64") {
			const estimatedBytes = Math.floor((candidate.output.data.length * 3) / 4);
			if (
				claim.mediaKind === "image" &&
				estimatedBytes > (dependencies.maxInlineImageBytes ?? DEFAULT_MAX_INLINE_IMAGE_BYTES)
			) {
				terminalFailure ??= {
					stage: "TRANSFER",
					code: "OUTPUT_MEDIA_SIZE_EXCEEDED",
					retryable: false,
				};
				continue;
			}
		}
		try {
			const result = await dependencies.persistCandidate(claim, candidate);
			results.push({ ...result, candidateKey: candidate.key });
		} catch (error) {
			const failure = { ...finalizationFailure(error), candidateKey: candidate.key };
			if (failure.retryable) {
				retryFailure ??= failure;
			} else {
				// Keep scanning independent candidates: an invalid provider item must not
				// hide a valid sibling output. The store persists this evidence together
				// with the one settlement outbox row after the scan completes.
				terminalFailure ??= failure;
			}
		}
	}
	const pending = results.filter((result) => result.moderationPending);
	const outputReviewEventIds = [
		...new Set(
			pending.flatMap((result) => (result.outputReviewEventId ? [result.outputReviewEventId] : [])),
		),
	];
	const continuation = pending.length ? { outputReviewEventIds } : {};
	if (retryFailure) {
		const resolution = await dependencies.store.recordFinalizationRetry(
			claim,
			retryFailure,
			results,
		);
		if (resolution?.outcome === "TERMINAL") {
			return {
				outcome: "FINALIZED",
				readyOutputs: results.filter((result) => result.approved).length,
			};
		}
		return {
			outcome: "RETRY_SCHEDULED",
			readyOutputs: results.filter((result) => result.approved).length,
			...continuation,
		};
	}
	if (pending.length) {
		if (claim.candidates.length > 1)
			await dependencies.store.recordFinalizationWait?.(claim, results);
		// Transfer completion already bound these private assets. Verification owns
		// the durable wait and wakes finalization when resolved; do not settle early
		// or spend the technical retry budget while the detector is processing.
		return {
			outcome: "WAITING_MODERATION",
			readyOutputs: results.filter((result) => result.approved).length,
			...continuation,
		};
	}
	if (terminalFailure) {
		await dependencies.store.recordFinalization(claim, results, terminalFailure);
	} else {
		await dependencies.store.recordFinalization(claim, results);
	}
	return { outcome: "FINALIZED", readyOutputs: results.filter((result) => result.approved).length };
}

function finalizationFailure(error: unknown): FinalizationFailure {
	const value = error as {
		code?: unknown;
		stage?: unknown;
		retryable?: unknown;
		assetId?: unknown;
		transferToken?: unknown;
	};
	return {
		code: typeof value.code === "string" ? value.code : "FINALIZATION_RETRYABLE",
		stage: value.stage === "MODERATION" ? "MODERATION" : "TRANSFER",
		retryable: value.retryable !== false,
		...(typeof value.assetId === "string" ? { assetId: value.assetId } : {}),
		...(typeof value.transferToken === "string" ? { transferToken: value.transferToken } : {}),
	};
}
