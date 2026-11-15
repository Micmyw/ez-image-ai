import { getCatalogEntry } from "@repo/ai";
import type { ProductModelKey } from "@repo/config";
import {
	getFinalizationContinuation,
	getAttemptGenerationContinuation,
	readStreamingImageFinalization,
	type ImagePhaseContext,
} from "@repo/database";
import type { PrismaClient } from "@repo/database/generated-client";
import { getImageProcessor } from "@repo/storage/image-processing/context";

import { GenerationTransferRequiresHeavyError } from "../contracts";
import type { TaskContinuation } from "../orchestration/contracts";
import { createFinalizationDependencies } from "../runtime";
import { finalizeMedia } from "./finalize-media";

/** Continue the authenticated completed attempt in its existing request/Workflow. */
export async function deliverCompletedProviderOriginal(
	attemptId: string,
	database: PrismaClient,
	phaseContext: ImagePhaseContext,
	environment = process.env,
): Promise<TaskContinuation | null> {
	if (environment.MEDIA_PROVIDER_ORIGINAL_DELIVERY_ENABLED !== "true" || !phaseContext.workflowId)
		return null;
	const attempt = await database.generationAttempt.findUnique({
		where: { id: attemptId },
		select: { jobId: true, status: true, uncertainSubmission: true },
	});
	if (!attempt || attempt.status !== "SUCCEEDED" || attempt.uncertainSubmission) return null;
	const projection = await readStreamingImageFinalization(attempt.jobId, database);
	if (
		!projection ||
		projection.attemptId !== attemptId ||
		projection.ownerType !== "USER" ||
		projection.outputs?.length !== 1
	)
		return null;
	if (getCatalogEntry(projection.productKey as ProductModelKey)?.mediaKind !== "image") return null;
	if (
		(projection.serviceClass === "GUEST_SLOW" || projection.guestTrialId) &&
		getImageProcessor().key !== "cloudflare-images"
	)
		return null;
	let result;
	try {
		result = await finalizeMedia(
			{ jobId: attempt.jobId, version: 0 },
			createFinalizationDependencies(environment, {
				database,
				providerOriginalOnly: true,
				directOriginalReview: true,
				phaseContext: { workflowId: phaseContext.workflowId },
			}),
		);
	} catch (error) {
		// Only this explicit no-write preflight decline permits the normal transfer path.
		// Unknown provider/persistence outcomes are never retried through another path.
		if (error instanceof GenerationTransferRequiresHeavyError) return null;
		throw error;
	}
	if (result.retryEvent)
		return { eventIds: [result.retryEvent.id], notBefore: result.retryEvent.availableAt };
	const original = await getAttemptGenerationContinuation(attemptId, database);
	if (result.outcome === "WAITING_MODERATION")
		return {
			eventIds: [...new Set([...original.eventIds, ...(result.outputReviewEventIds ?? [])])],
		};
	const finalization = await getFinalizationContinuation(attempt.jobId, database, {
		recoverRetry: result.outcome === "RETRY_SCHEDULED",
	});
	// Visibility is already committed. Drain the original finalizer/review receipts
	// in this Workflow too; normal completion must not depend on the global scanner.
	return {
		...finalization,
		eventIds: [
			...new Set([
				...original.eventIds,
				...(result.completedOutputReviewEventIds ?? []),
				...finalization.eventIds,
			]),
		],
	};
}
