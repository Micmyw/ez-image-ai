import {
	kieImageCallbackCompletionSchema,
	type KieImageCallbackCompletion,
} from "@repo/config/kie-image-callback";

import type { Prisma } from "../../generated/client";
import {
	createCallbackDatabaseTiming,
	type CallbackDatabaseTimingOptions,
} from "./callback-timing";
import { type ImagePhaseWakeResult } from "./image-phase-ownership";
import { runReadCommitted, type MediaTransactionClient } from "./types";

// This private inbox retains both legacy wake-only notices and HMAC-authenticated
// successful image candidates. Neither is a content approval or provider acceptance.
export const KIE_IMAGE_COMPLETION_NOTICE_PROVIDER = "kie-image-completion-notice";
export const KIE_IMAGE_COMPLETION_NOTICE_PREFIX = "image-completion-v1:";

export interface KieGenerationCallbackInput {
	attemptId: string;
	providerTaskId: string;
	completion?: KieImageCallbackCompletion;
}

function noticeId(attemptId: string, providerTaskId: string): string {
	return `${KIE_IMAGE_COMPLETION_NOTICE_PREFIX}${attemptId}:${providerTaskId}`;
}

/** Caller holds the attempt row lock; notices are consumed only when a query claims it. */
export async function kieGenerationCallbackRetryAt(
	attempt: { id: string; provider: string; providerTaskId: string | null },
	retryAt: Date,
	tx: Prisma.TransactionClient,
): Promise<Date> {
	if (attempt.provider !== "kie" || !attempt.providerTaskId) return retryAt;
	const notice = await tx.providerWebhookEvent.findUnique({
		where: {
			provider_providerEventId: {
				provider: KIE_IMAGE_COMPLETION_NOTICE_PROVIDER,
				providerEventId: noticeId(attempt.id, attempt.providerTaskId),
			},
		},
		select: { status: true },
	});
	return notice?.status === "RECEIVED" ? new Date() : retryAt;
}

export async function wakeKieGenerationAttempt(
	input: KieGenerationCallbackInput,
	client: MediaTransactionClient,
	options: CallbackDatabaseTimingOptions = {},
): Promise<"ready" | "terminal" | "recorded" | "invalid"> {
	return (await persistKieGenerationWake(input, client, options, false)).status;
}

export function wakeKieGenerationAttemptWithOwner(
	input: KieGenerationCallbackInput,
	client: MediaTransactionClient,
	options: CallbackDatabaseTimingOptions = {},
): Promise<ImagePhaseWakeResult> {
	return persistKieGenerationWake(input, client, options, true);
}

async function persistKieGenerationWake(
	input: KieGenerationCallbackInput,
	client: MediaTransactionClient,
	options: CallbackDatabaseTimingOptions,
	includeOwner: boolean,
): Promise<ImagePhaseWakeResult> {
	if (
		!/^[\w-]{1,128}$/.test(input.attemptId) ||
		!input.providerTaskId ||
		input.providerTaskId.length > 128
	)
		return { status: "invalid" };
	const timing = createCallbackDatabaseTiming(options);
	return timing.transaction<ImagePhaseWakeResult, Prisma.TransactionClient>(
		(body) => runReadCommitted(client, body),
		async (tx) => {
			const [attempt] = await timing.measure(
				"read",
				() => tx.$queryRaw<
					Array<{
						provider: string;
						providerTaskId: string | null;
						providerModelId: string;
						productKey: string;
						status: string;
						jobStatus: string;
						executionEngine: string;
					}>
				>`SELECT attempt."provider", attempt."providerTaskId", attempt."status", attempt."providerModelId", job."productKey",
			job."status" AS "jobStatus", job."executionEngine"
			FROM "generation_attempt" attempt JOIN "generation_job" job ON job."id" = attempt."jobId"
			WHERE attempt."id" = ${input.attemptId} FOR UPDATE OF attempt`,
			);
			if (!attempt || attempt.executionEngine !== "legacy" || attempt.provider !== "kie")
				return { status: "invalid" };
			if (attempt.providerTaskId && attempt.providerTaskId !== input.providerTaskId)
				return { status: "invalid" };
			const statuses = ["SUBMISSION_UNCERTAIN", "SUBMITTED", "RUNNING"] as const;
			const jobStatuses = ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"] as const;
			const manualRecovery =
				attempt.status === "NEEDS_RECONCILIATION" && attempt.jobStatus === "NEEDS_RECONCILIATION";
			if (
				!manualRecovery &&
				(!(statuses as readonly string[]).includes(attempt.status) ||
					!(jobStatuses as readonly string[]).includes(attempt.jobStatus))
			)
				return { status: "terminal" };
			const parsed = kieImageCallbackCompletionSchema.safeParse(input.completion);
			const completion =
				parsed.success &&
				parsed.data.providerTaskId === input.providerTaskId &&
				parsed.data.providerModelId === attempt.providerModelId &&
				attempt.productKey.startsWith("image-")
					? parsed.data
					: undefined;
			const envelope = JSON.stringify({
				kind: "image-generation-completion-notice-v1",
				executionEngine: "legacy",
				attemptId: input.attemptId,
				...(completion ? { completion } : {}),
			});
			const canWake = !manualRecovery && Boolean(attempt.providerTaskId);
			// Hold the attempt lock, then persist/upgrade the inbox, advance its due time,
			// and return the phase owner in one statement. A duplicate cannot replace
			// the first complete result, steal a lease, or reset a consumed notice.
			const [stored] = await timing.measure(
				"persist",
				() => tx.$queryRaw<
					Array<{
						status: string;
						phaseKey: string | null;
						workflowId: string | null;
						epoch: number | null;
					}>
				>`
			 WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS "now"),
			 previous AS MATERIALIZED (
			  SELECT "status" FROM "provider_webhook_event"
			  WHERE "provider" = ${KIE_IMAGE_COMPLETION_NOTICE_PROVIDER}
			   AND "providerEventId" = ${noticeId(input.attemptId, input.providerTaskId)}
			 ), persisted AS (
			  INSERT INTO "provider_webhook_event" AS notice
			   ("id", "provider", "providerEventId", "providerTaskId", "verifiedAt", "receivedAt", "envelope", "status")
			  SELECT gen_random_uuid()::text, ${KIE_IMAGE_COMPLETION_NOTICE_PROVIDER},
			   ${noticeId(input.attemptId, input.providerTaskId)}, ${input.providerTaskId}, stamp."now", stamp."now", ${envelope}::jsonb, 'RECEIVED'
			  FROM stamp
			  ON CONFLICT ("provider", "providerEventId") DO UPDATE
			   SET "envelope" = EXCLUDED."envelope", "status" = 'RECEIVED', "processedAt" = NULL,
			       "verifiedAt" = EXCLUDED."verifiedAt"
			   WHERE NOT (notice."envelope" ? 'completion') AND EXCLUDED."envelope" ? 'completion'
			  RETURNING "status"
			 ), advanced AS (
			  UPDATE "generation_attempt" SET "nextReconcileAt" = 'epoch'::timestamptz, "updatedAt" = stamp."now"
			  FROM stamp WHERE "id" = ${input.attemptId} AND ${canWake}::boolean AND EXISTS (SELECT 1 FROM persisted)
			  RETURNING "id"
			 )
			 SELECT COALESCE((SELECT "status"::text FROM persisted), (SELECT "status"::text FROM previous)) AS "status",
			  owner."phaseKey", owner."workflowId", owner."epoch"
			 FROM stamp LEFT JOIN "media_workflow_phase_owner" owner
			  ON ${includeOwner && canWake}::boolean AND owner."phaseKind" = 'generation'
			  AND owner."subjectId" = ${input.attemptId} AND owner."generation" = 0 AND owner."leasedUntil" > stamp."now"
			`,
			);
			if (!stored?.status) throw new Error("KIE_CALLBACK_PERSISTENCE_FAILED");
			if (!canWake || stored.status !== "RECEIVED") return { status: "recorded" };
			const phaseOwner =
				stored.phaseKey && stored.workflowId && stored.epoch
					? { phaseKey: stored.phaseKey, workflowId: stored.workflowId, epoch: stored.epoch }
					: undefined;
			return { status: "ready", ...(phaseOwner ? { phaseOwner } : {}) };
		},
	);
}
