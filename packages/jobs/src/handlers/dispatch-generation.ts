import { MediaProviderError } from "@repo/ai";

import type { DispatchDependencies, JobPayload } from "../contracts";

export async function dispatchGeneration(
	payload: JobPayload,
	dependencies: DispatchDependencies,
): Promise<{ outcome: "SKIPPED" | "SUBMITTED" | "RECONCILE" | "REJECTED" }> {
	const generationEnabled =
		dependencies.isGenerationEnabled?.() ?? process.env.MEDIA_GENERATION_ENABLED === "true";
	if (!generationEnabled) {
		throw new Error("MEDIA_GENERATION_DISABLED");
	}
	const claim = await dependencies.store.claimDispatch(payload);
	if (!claim) return { outcome: "SKIPPED" };
	const adapter = dependencies.getProvider(claim.provider);
	try {
		const submission = await adapter.submit({
			attemptId: claim.attemptId,
			providerModelId: claim.providerModelId,
			input: claim.input,
			webhookUrl: claim.webhookUrl,
		});
		if (submission.failure) {
			await dependencies.store.recordRejectedSubmission(claim.attemptId, submission.failure);
			return { outcome: "REJECTED" };
		}
		if (submission.status === "SUCCEEDED" && submission.snapshot) {
			const result = await adapter.normalizeResult(submission.snapshot);
			await dependencies.store.recordSynchronousCompletion(claim.attemptId, submission, result);
		} else {
			await dependencies.store.recordSubmission(claim.attemptId, submission);
		}
		if (submission.acceptance === "UNKNOWN") {
			await dependencies.store.recordUncertainSubmission(claim.attemptId);
			return { outcome: "RECONCILE" };
		}
		return { outcome: "SUBMITTED" };
	} catch (error) {
		if (error instanceof MediaProviderError && error.code !== "HTTP_ERROR") {
			await dependencies.store.recordRejectedSubmission(claim.attemptId, {
				code: error.code,
				message: error.message,
				retryable: error.retryable,
			});
			return { outcome: "REJECTED" };
		}
		await dependencies.store.recordUncertainSubmission(claim.attemptId);
		return { outcome: "RECONCILE" };
	}
}
