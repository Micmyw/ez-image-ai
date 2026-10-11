import { createHash } from "node:crypto";

import {
	KIE_ZERO_COST_REJECTION_CODE,
	hasKieChargeOrOutputEvidence,
	kieZeroCostRejectionEvidenceSchema,
	type KieZeroCostRejectionEvidence,
} from "@repo/config";

import type { Prisma } from "../../generated/client";
import { runSerializable, type MediaTransactionClient } from "./types";

/** The caller holds the attempt row lock; no positive-cost or output evidence may be overwritten. */
export async function canSettleKieZeroCostRejection(
	attemptId: string,
	evidence: KieZeroCostRejectionEvidence,
	tx: Prisma.TransactionClient,
): Promise<boolean> {
	const parsed = kieZeroCostRejectionEvidenceSchema.safeParse(evidence);
	if (!parsed.success) return false;
	const attempt = await tx.generationAttempt.findUnique({
		where: { id: attemptId },
		include: {
			transferEnvelope: { select: { attemptId: true } },
			job: {
				include: {
					reservation: true,
					_count: { select: { attempts: true, assets: { where: { role: "OUTPUT" } } } },
				},
			},
		},
	});
	if (!attempt) return false;
	return (
		attempt.provider === "kie" &&
		attempt.providerTaskId === evidence.taskId &&
		(!evidence.model || attempt.providerModelId === evidence.model) &&
		attempt.job.executionEngine === "legacy" &&
		attempt.job.productKey.startsWith("image-") &&
		attempt.job._count.attempts === 1 &&
		attempt.job._count.assets === 0 &&
		attempt.transferEnvelope === null &&
		attempt.providerResultUrl === null &&
		(attempt.providerCostMicros === null || attempt.providerCostMicros === 0n) &&
		!hasKieChargeOrOutputEvidence(attempt.responseSnapshot) &&
		attempt.job.reservation?.status === "ACTIVE" &&
		attempt.job.reservation.settledAmount === 0n &&
		attempt.job.reservation.releasedAmount === 0n
	);
}

export interface ResolveKieZeroCostRejectionInput {
	attemptId: string;
	evidence: KieZeroCostRejectionEvidence;
	providerEvidenceReference: string;
	actorUserId: string;
	idempotencyKey: string;
	reason: string;
}

export async function resolveAdminKieZeroCostRejection(
	input: ResolveKieZeroCostRejectionInput,
	client: MediaTransactionClient,
): Promise<{
	jobId: string;
	attemptId: string;
	reservedCredits: string;
	settlementEventId: string;
	replayed: boolean;
}> {
	const evidence = kieZeroCostRejectionEvidenceSchema.parse(input.evidence);
	if (
		evidence.source !== "dashboard-log" ||
		input.providerEvidenceReference.trim().length < 10 ||
		input.reason.trim().length < 10 ||
		!input.actorUserId ||
		input.idempotencyKey.length < 8
	) {
		throw new Error("KIE_REJECTION_ADMIN_EVIDENCE_REQUIRED");
	}
	const operationId = `operation:${input.idempotencyKey}`;
	const requestFingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				attemptId: input.attemptId,
				evidence,
				providerEvidenceReference: input.providerEvidenceReference,
				actorUserId: input.actorUserId,
				reason: input.reason,
			}),
		)
		.digest("hex");
	return runSerializable(client, async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-media:${input.idempotencyKey}`}, 0))`;
		const replay = await tx.auditLog.findFirst({
			where: { targetType: "ADMIN_MEDIA_OPERATION", targetId: operationId },
		});
		if (replay) {
			const metadata = replay.metadata as Record<string, unknown> | null;
			if (
				metadata?.operationKind !== "RESOLVE_KIE_ZERO_COST_REJECTION" ||
				metadata.requestFingerprint !== requestFingerprint
			)
				throw new Error("IDEMPOTENCY_CONFLICT");
			const after = replay.after as {
				jobId: string;
				attemptId: string;
				reservedCredits: string;
				settlementEventId: string;
			};
			return { ...after, replayed: true };
		}
		const observedAt = Date.parse(evidence.observedAt);
		if (observedAt > Date.now() + 60_000 || observedAt < Date.now() - 15 * 60_000)
			throw new Error("KIE_REJECTION_EVIDENCE_STALE");
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-media:uncertain-attempt:${input.attemptId}`}, 0))`;
		await tx.$queryRaw`SELECT "id" FROM "generation_attempt" WHERE "id" = ${input.attemptId} FOR UPDATE`;
		const attempt = await tx.generationAttempt.findUnique({
			where: { id: input.attemptId },
			include: { job: { include: { reservation: true } } },
		});
		if (!attempt) throw new Error("ATTEMPT_NOT_FOUND");
		if (attempt.job.executionEngine !== "legacy") throw new Error("EXECUTION_ENGINE_NOT_OWNED");
		await tx.$queryRaw`SELECT "id" FROM "generation_job" WHERE "id" = ${attempt.jobId} FOR UPDATE`;
		if (
			attempt.status !== "NEEDS_RECONCILIATION" ||
			attempt.job.status !== "NEEDS_RECONCILIATION" ||
			!attempt.uncertainSubmission ||
			attempt.job.failureCode !== "RECONCILIATION_TERMINAL_UNVERIFIED"
		)
			throw new Error("ATTEMPT_NOT_AWAITING_TERMINAL_RECONCILIATION");
		if (!(await canSettleKieZeroCostRejection(attempt.id, evidence, tx)))
			throw new Error("KIE_REJECTION_EVIDENCE_CONFLICT");
		const reservation = attempt.job.reservation!;
		await tx.generationAttempt.update({
			where: { id: attempt.id },
			data: {
				status: "FAILED",
				uncertainSubmission: false,
				completedAt: new Date(),
				providerCostMicros: 0n,
				reconcileLeaseToken: null,
				reconcileLeasedUntil: null,
				nextReconcileAt: null,
				responseSnapshot: {
					providerCharged: false,
					outputCount: 0,
					confirmedZeroCostRejection: evidence,
				},
				errorSnapshot: {
					code: KIE_ZERO_COST_REJECTION_CODE,
					retryable: false,
					providerEvidenceReference: input.providerEvidenceReference,
				},
			},
		});
		const job = await tx.generationJob.update({
			where: { id: attempt.jobId },
			data: {
				status: "FINALIZING",
				failureCode: KIE_ZERO_COST_REJECTION_CODE,
				version: { increment: 1 },
			},
		});
		const settlement = await tx.outboxEvent.upsert({
			where: { dedupeKey: `generation-settle:${job.id}` },
			create: {
				eventType: "GENERATION_SETTLE",
				aggregateType: "GENERATION_JOB",
				aggregateId: job.id,
				dedupeKey: `generation-settle:${job.id}`,
				payload: { jobId: job.id, version: job.version },
			},
			update: {},
		});
		if (settlement.status !== "PENDING") throw new Error("KIE_REJECTION_SETTLEMENT_EVENT_CONFLICT");
		const result = {
			jobId: job.id,
			attemptId: attempt.id,
			reservedCredits: reservation.amount.toString(),
			settlementEventId: settlement.id,
		};
		await tx.auditLog.create({
			data: {
				actorUserId: input.actorUserId,
				action: "MEDIA_KIE_ZERO_COST_REJECTION_CONFIRMED",
				targetType: "ADMIN_MEDIA_OPERATION",
				targetId: operationId,
				before: {
					jobId: job.id,
					jobStatus: attempt.job.status,
					attemptStatus: attempt.status,
					failureCode: attempt.job.failureCode,
					responseSnapshot: attempt.responseSnapshot,
					errorSnapshot: attempt.errorSnapshot,
					providerCostMicros: attempt.providerCostMicros?.toString() ?? null,
					reservationId: reservation.id,
					reservedCredits: reservation.amount.toString(),
				},
				after: result,
				metadata: {
					operationKind: "RESOLVE_KIE_ZERO_COST_REJECTION",
					requestFingerprint,
					reason: input.reason,
					providerEvidenceReference: input.providerEvidenceReference,
					evidence,
				},
			},
		});
		return { ...result, replayed: false };
	});
}
