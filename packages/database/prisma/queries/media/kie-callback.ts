import type { Prisma } from "../../generated/client";
import { getImagePhaseOwner, type ImagePhaseWakeResult } from "./image-phase-ownership";
import { runReadCommitted, type MediaTransactionClient } from "./types";

// A completion notification is neither an authenticated result nor an acceptance.
// It has its own namespace and never enters PROVIDER_EVENT_RECEIVED processing.
export const KIE_IMAGE_COMPLETION_NOTICE_PROVIDER = "kie-image-completion-notice";
export const KIE_IMAGE_COMPLETION_NOTICE_PREFIX = "image-completion-v1:";

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
	input: { attemptId: string; providerTaskId: string },
	client: MediaTransactionClient,
	options: { onTiming?: (stage: "read" | "persist", elapsedMs: number) => void } = {},
): Promise<"ready" | "terminal" | "recorded" | "invalid"> {
	return (await persistKieGenerationWake(input, client, options, false)).status;
}

export function wakeKieGenerationAttemptWithOwner(
	input: { attemptId: string; providerTaskId: string },
	client: MediaTransactionClient,
	options: { onTiming?: (stage: "read" | "persist", elapsedMs: number) => void } = {},
): Promise<ImagePhaseWakeResult> {
	return persistKieGenerationWake(input, client, options, true);
}

async function persistKieGenerationWake(
	input: { attemptId: string; providerTaskId: string },
	client: MediaTransactionClient,
	options: { onTiming?: (stage: "read" | "persist", elapsedMs: number) => void },
	includeOwner: boolean,
): Promise<ImagePhaseWakeResult> {
	if (
		!/^[\w-]{1,128}$/.test(input.attemptId) ||
		!input.providerTaskId ||
		input.providerTaskId.length > 128
	)
		return { status: "invalid" };
	const measure = async <T>(stage: "read" | "persist", operation: () => Promise<T>): Promise<T> => {
		const started = performance.now();
		try {
			return await operation();
		} finally {
			try {
				options.onTiming?.(stage, performance.now() - started);
			} catch {
				/* Timing cannot change callback persistence or retry behavior. */
			}
		}
	};
	return runReadCommitted(client, async (tx) => {
		const result = async (
			status: ImagePhaseWakeResult["status"],
		): Promise<ImagePhaseWakeResult> => {
			const phaseOwner =
				includeOwner && status === "ready"
					? await getImagePhaseOwner({ kind: "generation", attemptId: input.attemptId }, tx)
					: undefined;
			return { status, ...(phaseOwner ? { phaseOwner } : {}) };
		};
		const [attempt] = await measure(
			"read",
			() => tx.$queryRaw<
				Array<{
					provider: string;
					providerTaskId: string | null;
					status: string;
					jobStatus: string;
					executionEngine: string;
				}>
			>`SELECT attempt."provider", attempt."providerTaskId", attempt."status",
			job."status" AS "jobStatus", job."executionEngine"
			FROM "generation_attempt" attempt JOIN "generation_job" job ON job."id" = attempt."jobId"
			WHERE attempt."id" = ${input.attemptId} FOR UPDATE OF attempt`,
		);
		if (!attempt || attempt.executionEngine !== "legacy" || attempt.provider !== "kie")
			return result("invalid");
		if (attempt.providerTaskId && attempt.providerTaskId !== input.providerTaskId)
			return result("invalid");
		const statuses = ["SUBMISSION_UNCERTAIN", "SUBMITTED", "RUNNING"] as const;
		const jobStatuses = ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"] as const;
		if (
			!(statuses as readonly string[]).includes(attempt.status) ||
			!(jobStatuses as readonly string[]).includes(attempt.jobStatus)
		)
			return result("terminal");
		return measure("persist", async () => {
			const now = new Date();
			const inserted = await tx.providerWebhookEvent.createMany({
				skipDuplicates: true,
				data: {
					provider: KIE_IMAGE_COMPLETION_NOTICE_PROVIDER,
					providerEventId: noticeId(input.attemptId, input.providerTaskId),
					providerTaskId: input.providerTaskId,
					verifiedAt: now,
					receivedAt: now,
					envelope: {
						kind: "image-generation-completion-notice-v1",
						executionEngine: "legacy",
						attemptId: input.attemptId,
					},
				},
			});
			// Early notices remain bound to their claimed task ID, not to an accepted task.
			if (!attempt.providerTaskId) return result("recorded");
			if (inserted.count !== 1) {
				// Retry an unconsumed wake after a lost transport response. Never reset
				// the due time; once a query consumes the notice, provider backoff wins.
				const prior = await tx.providerWebhookEvent.findUnique({
					where: {
						provider_providerEventId: {
							provider: KIE_IMAGE_COMPLETION_NOTICE_PROVIDER,
							providerEventId: noticeId(input.attemptId, input.providerTaskId),
						},
					},
					select: { status: true },
				});
				return result(prior?.status === "RECEIVED" ? "ready" : "recorded");
			}
			const updated = await tx.generationAttempt.updateMany({
				where: {
					id: input.attemptId,
					provider: "kie",
					providerTaskId: input.providerTaskId,
					status: { in: [...statuses] },
					job: { executionEngine: "legacy", status: { in: [...jobStatuses] } },
				},
				// Never clear a lease, change business state, or settle credits here.
				data: { nextReconcileAt: now },
			});
			return result(updated.count === 1 ? "ready" : "terminal");
		});
	});
}
