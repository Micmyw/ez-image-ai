import { MediaProviderError, type ProviderSubmission } from "@repo/ai";

import type { DispatchDependencies, DispatchJobPayload } from "../contracts";

export async function dispatchGeneration(
	payload: DispatchJobPayload,
	dependencies: DispatchDependencies,
): Promise<{
	outcome: "SKIPPED" | "SUBMITTED" | "RECONCILE" | "REJECTED" | "RECOVERY_REQUIRED";
}> {
	const generationEnabled =
		dependencies.isGenerationEnabled?.() ?? process.env.MEDIA_GENERATION_ENABLED === "true";
	if (!generationEnabled) {
		throw new Error("MEDIA_GENERATION_DISABLED");
	}
	const claim = await dependencies.store.claimDispatch(payload);
	if (!claim) return { outcome: "SKIPPED" };
	if (claim.serviceClass === "GUEST_SLOW" && claim.attemptNumber !== 1) {
		throw new Error("GUEST_ATTEMPT_LIMIT_EXCEEDED");
	}
	let adapter;
	try {
		adapter = dependencies.getProvider(claim.provider);
	} catch {
		await dependencies.store.recordProviderAdapterUnavailable(claim.attemptId);
		return { outcome: "RECOVERY_REQUIRED" };
	}
	try {
		await dependencies.store.recordSubmissionStarted(claim.attemptId);
		const submission = await adapter.submit({
			attemptId: claim.attemptId,
			providerModelId: claim.providerModelId,
			input: claim.input,
			webhookUrl: claim.webhookUrl,
		});
		if (submission.outcome === "uncertain") {
			await dependencies.store.recordUncertainSubmission(
				claim.attemptId,
				uncertaintyEvidenceFromSubmission(submission),
			);
			return { outcome: "RECONCILE" };
		}
		if (submission.outcome === "rejected") {
			if (!submission.failure)
				throw new Error("Rejected provider submission omitted its failure evidence");
			await dependencies.store.recordRejectedSubmission(claim.attemptId, submission.failure);
			return { outcome: "REJECTED" };
		}
		if (submission.status === "SUCCEEDED" && submission.snapshot) {
			const result = await adapter.normalizeResult(submission.snapshot);
			await dependencies.store.recordSynchronousCompletion(claim.attemptId, submission, result);
		} else {
			await dependencies.store.recordSubmission(claim.attemptId, submission);
		}
		return { outcome: "SUBMITTED" };
	} catch (error) {
		if (
			error instanceof MediaProviderError &&
			error.code !== "HTTP_ERROR" &&
			error.code !== "MALFORMED_PROVIDER_RESPONSE"
		) {
			await dependencies.store.recordRejectedSubmission(claim.attemptId, {
				code: error.code,
				message: error.message,
				retryable: error.retryable,
			});
			return { outcome: "REJECTED" };
		}
		await dependencies.store.recordUncertainSubmission(claim.attemptId, {
			classification:
				error instanceof MediaProviderError && error.code === "MALFORMED_PROVIDER_RESPONSE"
					? "malformed_2xx"
					: "transport",
			phase: "post_send",
		});
		return { outcome: "RECONCILE" };
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
