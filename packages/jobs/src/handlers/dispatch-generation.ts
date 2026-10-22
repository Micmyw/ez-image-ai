import { MediaProviderError, type ProviderSubmission } from "@repo/ai";

import type {
	DispatchContinuation,
	DispatchDependencies,
	DispatchJobPayload,
	DispatchOwnershipLost,
} from "../contracts";

export async function dispatchGeneration(
	payload: DispatchJobPayload,
	dependencies: DispatchDependencies,
): Promise<{
	outcome: "SKIPPED" | "DEFERRED" | "SUBMITTED" | "RECONCILE" | "REJECTED" | "RECOVERY_REQUIRED";
	retryAfterMs?: number;
	continuation?: DispatchContinuation;
	phaseOwnershipLost?: true;
	phaseOwner?: import("@repo/database").ImagePhaseOwner;
}> {
	const generationEnabled =
		dependencies.isGenerationEnabled?.() ?? process.env.MEDIA_GENERATION_ENABLED === "true";
	if (!generationEnabled) {
		throw new Error("MEDIA_GENERATION_DISABLED");
	}
	const claim = await dependencies.store.claimDispatch(payload);
	if (!claim) return { outcome: "SKIPPED" };
	if ("phaseOwnershipLost" in claim) return { outcome: "SKIPPED", ...claim };
	if ("deferred" in claim) {
		return {
			outcome: "DEFERRED",
			retryAfterMs: claim.retryAfterMs,
			continuation: claim.continuation,
		};
	}
	if (claim.serviceClass === "GUEST_SLOW" && claim.attemptNumber !== 1) {
		throw new Error("GUEST_ATTEMPT_LIMIT_EXCEEDED");
	}
	let adapter;
	try {
		adapter = dependencies.getProvider(claim.provider);
	} catch {
		const held = await dependencies.store.recordProviderAdapterUnavailable(
			claim.attemptId,
			claim.phaseOwner,
		);
		return { outcome: "RECOVERY_REQUIRED", ...held };
	}
	try {
		if (
			(await dependencies.store.recordSubmissionStarted(
				claim.attemptId,
				claim.phaseOwner,
				claim,
			)) === false
		)
			return {
				outcome: "SKIPPED",
				phaseOwnershipLost: true,
				...(claim.phaseOwner ? { phaseOwner: claim.phaseOwner } : {}),
			};
		const submission = await adapter.submit({
			attemptId: claim.attemptId,
			providerModelId: claim.providerModelId,
			input: claim.input,
			webhookUrl: claim.webhookUrl,
		});
		if (submission.outcome === "uncertain") {
			const held = await dependencies.store.recordUncertainSubmission(
				claim.attemptId,
				uncertaintyEvidenceFromSubmission(submission),
				claim.phaseOwner,
			);
			return { outcome: "RECONCILE", ...held };
		}
		if (submission.outcome === "rejected") {
			if (!submission.failure)
				throw new Error("Rejected provider submission omitted its failure evidence");
			const held = await dependencies.store.recordRejectedSubmission(
				claim.attemptId,
				submission.failure,
				claim.phaseOwner,
			);
			return { outcome: "REJECTED", ...held };
		}
		let continuation: DispatchContinuation | DispatchOwnershipLost | void;
		if (submission.status === "SUCCEEDED" && submission.snapshot) {
			const result = await adapter.normalizeResult(submission.snapshot);
			continuation = await dependencies.store.recordSynchronousCompletion(
				claim.attemptId,
				submission,
				result,
				claim.phaseOwner,
			);
		} else {
			continuation = await dependencies.store.recordSubmission(
				claim.attemptId,
				submission,
				claim.phaseOwner,
			);
			// Acceptance is already durable. Scheduler failure must never turn it into
			// submission uncertainty or trigger another Provider submission.
			try {
				if (!continuation || !("phaseOwnershipLost" in continuation))
					await dependencies.schedulePolling?.(claim.attemptId);
			} catch {
				// Scheduled reconciliation can recover the same persisted attempt.
			}
		}
		if (continuation && "phaseOwnershipLost" in continuation)
			return { outcome: "SUBMITTED", ...continuation };
		return { outcome: "SUBMITTED", ...(continuation === undefined ? {} : { continuation }) };
	} catch (error) {
		if (
			error instanceof MediaProviderError &&
			error.code !== "HTTP_ERROR" &&
			error.code !== "MALFORMED_PROVIDER_RESPONSE"
		) {
			const held = await dependencies.store.recordRejectedSubmission(
				claim.attemptId,
				{
					code: error.code,
					message: error.message,
					retryable: error.retryable,
				},
				claim.phaseOwner,
			);
			return { outcome: "REJECTED", ...held };
		}
		const held = await dependencies.store.recordUncertainSubmission(
			claim.attemptId,
			{
				classification:
					error instanceof MediaProviderError && error.code === "MALFORMED_PROVIDER_RESPONSE"
						? "malformed_2xx"
						: "transport",
				phase: "post_send",
			},
			claim.phaseOwner,
		);
		return { outcome: "RECONCILE", ...held };
	}
}

function uncertaintyEvidenceFromSubmission(
	submission: Extract<ProviderSubmission, { outcome: "uncertain" }>,
) {
	return {
		...submission.uncertainty,
		...(submission.providerTaskId ? { providerTaskId: submission.providerTaskId } : {}),
		providerStatus: submission.status,
		...(submission.reconciliation.statusUrl
			? { statusUrl: submission.reconciliation.statusUrl }
			: {}),
		...(submission.reconciliation.resultUrl
			? { resultUrl: submission.reconciliation.resultUrl }
			: {}),
		...(submission.reconciliation.submissionToken
			? { submissionToken: submission.reconciliation.submissionToken }
			: {}),
		providerIdempotencySupported: submission.idempotency.providerSupported,
	};
}
