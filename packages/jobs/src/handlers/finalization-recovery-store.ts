import type { Prisma, PrismaClient } from "@repo/database/generated-client";

import type { FinalizingGenerationRecoveryDependencies } from "./recover-finalizing-generations";

export const FINALIZATION_RECOVERY_MAX_ATTEMPTS = 8;
export const FINALIZATION_RECOVERY_EXHAUSTED_CODE = "FINALIZATION_RECOVERY_EXHAUSTED";
export const FINALIZATION_RECOVERY_EXHAUSTED_ACTION =
	"MEDIA_GENERATION_FINALIZATION_RECOVERY_EXHAUSTED";

type FinalizingGenerationRecoveryStore = Pick<
	FinalizingGenerationRecoveryDependencies,
	"listCandidates" | "recoverCandidate"
>;

type RecoveryRoute = "FINALIZE" | "SETTLE";

const FINALIZE_EVENT_TYPES = new Set(["GENERATION_FINALIZE", "GENERATION_FINALIZE_RETRY"]);

export function createDatabaseFinalizingGenerationRecoveryStore(
	database: PrismaClient,
): FinalizingGenerationRecoveryStore {
	return {
		async listCandidates({ limit, now, staleBefore }) {
			return database.$queryRaw<Array<{ jobId: string }>>`
				SELECT job."id" AS "jobId"
				FROM "generation_job" job
				LEFT JOIN "credit_reservation" reservation ON reservation."jobId" = job."id"
				WHERE (
					job."status" = 'FINALIZING'
					OR (job."status" = 'CANCELED' AND reservation."status" = 'ACTIVE')
				)
				AND (
					job."nextFinalizeAt" <= ${now}
					OR (job."nextFinalizeAt" IS NULL AND job."updatedAt" <= ${staleBefore})
				)
				AND NOT (
					job."finalizationRetryCount" >= ${FINALIZATION_RECOVERY_MAX_ATTEMPTS}
					AND COALESCE(job."finalizationErrorCode", '') = ${FINALIZATION_RECOVERY_EXHAUSTED_CODE}
				)
				ORDER BY COALESCE(job."nextFinalizeAt", job."updatedAt"), job."id"
				LIMIT ${limit}
			`;
		},
		async recoverCandidate(candidate, input) {
			return database.$transaction(async (tx) => {
				const locked = await tx.$queryRaw<Array<{ id: string }>>`
					SELECT "id" FROM "generation_job" WHERE "id" = ${candidate.jobId} FOR UPDATE
				`;
				if (locked.length !== 1) return "SKIPPED";

				const job = await tx.generationJob.findUnique({
					where: { id: candidate.jobId },
					include: {
						reservation: { select: { status: true } },
						attempts: {
							where: { status: "SUCCEEDED" },
							select: { id: true },
							take: 1,
						},
					},
				});
				if (!job || !isApplicableStatus(job.status, job.reservation?.status)) return "SKIPPED";
				if (
					job.finalizationRetryCount >= FINALIZATION_RECOVERY_MAX_ATTEMPTS &&
					job.finalizationErrorCode === FINALIZATION_RECOVERY_EXHAUSTED_CODE
				) {
					return "EXHAUSTED";
				}
				if (!isRecoveryDue(job.nextFinalizeAt, job.updatedAt, input)) return "SKIPPED";

				const outboxEvents = await tx.outboxEvent.findMany({
					where: {
						aggregateType: "GENERATION_JOB",
						aggregateId: job.id,
						eventType: {
							in: ["GENERATION_FINALIZE", "GENERATION_FINALIZE_RETRY", "GENERATION_SETTLE"],
						},
					},
					select: { eventType: true, status: true },
				});
				const route = selectRecoveryRoute({
					jobStatus: job.status,
					hasHistoricalSettle: outboxEvents.some(
						(event) => event.eventType === "GENERATION_SETTLE",
					),
					hasSucceededAttempt: job.attempts.length > 0,
				});
				if (
					outboxEvents.some(
						(event) =>
							(event.status === "PENDING" || event.status === "LEASED") &&
							isRouteEvent(route, event.eventType),
					)
				) {
					return "SKIPPED";
				}

				if (job.finalizationRetryCount >= FINALIZATION_RECOVERY_MAX_ATTEMPTS) {
					await recordRecoveryExhaustion(tx, {
						jobId: job.id,
						jobStatus: job.status,
						retryCount: job.finalizationRetryCount,
						route,
					});
					return "EXHAUSTED";
				}

				const recoveryAttempt = job.finalizationRetryCount + 1;
				const nextFinalizeAt = new Date(
					input.now.getTime() + Math.min(60, 2 ** recoveryAttempt) * 60_000,
				);
				const eventType = route === "FINALIZE" ? "GENERATION_FINALIZE_RETRY" : "GENERATION_SETTLE";
				await tx.generationJob.update({
					where: { id: job.id },
					data: {
						finalizationRetryCount: recoveryAttempt,
						finalizationErrorCode:
							route === "FINALIZE" ? "FINALIZATION_RECOVERY_QUEUED" : "SETTLEMENT_RECOVERY_QUEUED",
						nextFinalizeAt,
					},
				});
				await tx.outboxEvent.create({
					data: {
						eventType,
						aggregateType: "GENERATION_JOB",
						aggregateId: job.id,
						dedupeKey: `generation-recovery:${job.id}:${route.toLowerCase()}:${recoveryAttempt}`,
						payload: {
							jobId: job.id,
							version: job.version,
							recoveryRoute: route,
							recoveryAttempt,
						},
						availableAt: input.now,
					},
				});
				return "RECOVERED";
			});
		},
	};
}

function isApplicableStatus(jobStatus: string, reservationStatus: string | undefined): boolean {
	return jobStatus === "FINALIZING" || (jobStatus === "CANCELED" && reservationStatus === "ACTIVE");
}

function isRecoveryDue(
	nextFinalizeAt: Date | null,
	updatedAt: Date,
	input: { now: Date; staleBefore: Date },
): boolean {
	return nextFinalizeAt
		? nextFinalizeAt.getTime() <= input.now.getTime()
		: updatedAt.getTime() <= input.staleBefore.getTime();
}

function selectRecoveryRoute(input: {
	jobStatus: string;
	hasHistoricalSettle: boolean;
	hasSucceededAttempt: boolean;
}): RecoveryRoute {
	if (input.jobStatus === "CANCELED" || input.hasHistoricalSettle) return "SETTLE";
	return input.hasSucceededAttempt ? "FINALIZE" : "SETTLE";
}

function isRouteEvent(route: RecoveryRoute, eventType: string): boolean {
	return route === "FINALIZE"
		? FINALIZE_EVENT_TYPES.has(eventType)
		: eventType === "GENERATION_SETTLE";
}

async function recordRecoveryExhaustion(
	tx: Prisma.TransactionClient,
	input: {
		jobId: string;
		jobStatus: string;
		retryCount: number;
		route: RecoveryRoute;
	},
): Promise<void> {
	const existingAudit = await tx.auditLog.findFirst({
		where: {
			action: FINALIZATION_RECOVERY_EXHAUSTED_ACTION,
			targetType: "GENERATION_JOB",
			targetId: input.jobId,
		},
		select: { id: true },
	});
	if (!existingAudit) {
		await tx.auditLog.create({
			data: {
				action: FINALIZATION_RECOVERY_EXHAUSTED_ACTION,
				targetType: "GENERATION_JOB",
				targetId: input.jobId,
				after: {
					finalizationRetryCount: input.retryCount,
					finalizationErrorCode: FINALIZATION_RECOVERY_EXHAUSTED_CODE,
				},
				metadata: {
					automatic: true,
					jobStatus: input.jobStatus,
					recoveryRoute: input.route,
				},
			},
		});
	}
	await tx.generationJob.update({
		where: { id: input.jobId },
		data: {
			finalizationErrorCode: FINALIZATION_RECOVERY_EXHAUSTED_CODE,
			nextFinalizeAt: null,
		},
	});
}
