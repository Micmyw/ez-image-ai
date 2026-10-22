import type { ImagePhaseOwner } from "../../../shared/image-phase-ownership";
import type { Prisma } from "../../generated/client";

/** Private evidence of the exact attempt/job tuples prepared by one transaction. */
export interface GenerationSubmissionPreparation {
	attemptId: string;
	attemptNumber: number;
	jobId: string;
	jobVersion: number;
	provider: string;
	providerModelId: string;
	requestFingerprint: string;
	submittedAt: string;
	attemptRowVersion: string;
	jobRowVersion: string;
}

/** The caller has already claimed the job and, for an existing attempt, its row lock. */
export async function prepareGenerationSubmissionInTransaction(
	input: {
		attemptId: string;
		attemptNumber: number;
		jobId: string;
		jobVersion: number;
		provider: string;
		providerModelId: string;
		inputSnapshot: unknown;
		pricingSnapshot: unknown;
		requestSnapshot: Prisma.InputJsonValue;
		now: Date;
		nextReconcileAt: Date;
	},
	tx: Prisma.TransactionClient,
): Promise<GenerationSubmissionPreparation> {
	const request = input.requestSnapshot as {
		requestFingerprint?: unknown;
		submissionPhase?: unknown;
	};
	if (typeof request.requestFingerprint !== "string" || request.submissionPhase !== "pre_send")
		throw new Error("INVALID_GENERATION_SUBMISSION_PREPARATION");
	const [written] = await tx.$queryRaw<Array<{ attemptRowVersion: string; jobRowVersion: string }>>`
		UPDATE "generation_attempt" AS attempt SET
		 "status" = 'SUBMISSION_UNCERTAIN', "uncertainSubmission" = true,
		 "submittedAt" = ${input.now}, "nextReconcileAt" = ${input.nextReconcileAt},
		 "requestSnapshot" = ${JSON.stringify(input.requestSnapshot)}::jsonb, "updatedAt" = ${new Date()}
		FROM "generation_job" AS job
		WHERE attempt."id" = ${input.attemptId} AND attempt."jobId" = job."id"
		 AND job."id" = ${input.jobId} AND job."executionEngine" = 'legacy'
		 AND job."status" = 'SUBMITTING' AND job."version" = ${input.jobVersion}
		 AND job."inputSnapshot" = ${JSON.stringify(input.inputSnapshot)}::jsonb
		 AND job."pricingSnapshot" = ${JSON.stringify(input.pricingSnapshot)}::jsonb
		RETURNING attempt.xmin::text AS "attemptRowVersion", job.xmin::text AS "jobRowVersion"`;
	if (!written || !/^\d+$/.test(written.attemptRowVersion) || !/^\d+$/.test(written.jobRowVersion))
		throw new Error("GENERATION_SUBMISSION_PREPARATION_CHANGED");
	return {
		attemptId: input.attemptId,
		attemptNumber: input.attemptNumber,
		jobId: input.jobId,
		jobVersion: input.jobVersion,
		provider: input.provider,
		providerModelId: input.providerModelId,
		requestFingerprint: request.requestFingerprint,
		submittedAt: input.now.toISOString(),
		...written,
	};
}

/** The new statement after the row lock must observe any owner takeover that waited on it. */
export async function isGenerationSubmissionPreparationCurrentInTransaction(
	prepared: GenerationSubmissionPreparation,
	phaseOwner: ImagePhaseOwner | undefined,
	tx: Prisma.TransactionClient,
): Promise<boolean> {
	await tx.$queryRaw`SELECT "id" FROM "generation_attempt" WHERE "id" = ${prepared.attemptId} FOR UPDATE`;
	const [result] = await tx.$queryRaw<Array<{ canSend: boolean }>>`
		SELECT EXISTS (
		 SELECT 1 FROM "generation_attempt" attempt
		 JOIN "generation_job" job ON job."id" = attempt."jobId"
		 WHERE attempt."id" = ${prepared.attemptId} AND job."id" = ${prepared.jobId}
		  AND attempt.xmin::text = ${prepared.attemptRowVersion}
		  AND job.xmin::text = ${prepared.jobRowVersion}
		  AND job."executionEngine" = 'legacy' AND job."status" = 'SUBMITTING'
		  AND job."version" = ${prepared.jobVersion}
		  AND attempt."attemptNumber" = ${prepared.attemptNumber}
		  AND attempt."provider" = ${prepared.provider} AND attempt."providerModelId" = ${prepared.providerModelId}
		  AND attempt."status" = 'SUBMISSION_UNCERTAIN' AND attempt."uncertainSubmission" = true
		  AND attempt."submittedAt" = ${new Date(prepared.submittedAt)}
		  AND attempt."requestSnapshot"->>'requestFingerprint' = ${prepared.requestFingerprint}
		  AND attempt."requestSnapshot"->>'submissionPhase' = 'pre_send'
		  AND attempt."providerTaskId" IS NULL AND attempt."completedAt" IS NULL
		  AND attempt."reconcileLeaseToken" IS NULL AND attempt."reconcileLeasedUntil" IS NULL
		  AND (
		   (${Boolean(phaseOwner)}::boolean AND EXISTS (
		    SELECT 1 FROM "media_workflow_phase_owner" owner
		    WHERE owner."phaseKind" = 'generation' AND owner."subjectId" = attempt."id" AND owner."generation" = 0
		     AND owner."phaseKey" = ${phaseOwner?.phaseKey ?? null} AND owner."workflowId" = ${phaseOwner?.workflowId ?? null}
		     AND owner."epoch" = ${phaseOwner?.epoch ?? null} AND owner."leasedUntil" > clock_timestamp()
		   )) OR (${!phaseOwner}::boolean AND NOT EXISTS (
		    SELECT 1 FROM "media_workflow_phase_owner" owner
		    WHERE owner."phaseKind" = 'generation' AND owner."subjectId" = attempt."id" AND owner."generation" = 0
		     AND owner."leasedUntil" > clock_timestamp()
		   ))
		  )
		) AS "canSend"`;
	return result?.canSend === true;
}
