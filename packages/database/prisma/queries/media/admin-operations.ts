import type { Prisma } from "../../generated/client";
import type { MediaTransactionClient } from "./types";

export type PersistedEventKind = "PAYMENT" | "PROVIDER";
export type AdminRetryStage = "DISPATCH" | "FINALIZE" | "SETTLE";

interface AuditRecordProjection {
	id: string;
	actorUserId: string | null;
	action: string;
	targetType: string;
	targetId: string;
	createdAt: Date;
	[key: string]: unknown;
}

export interface SafeAuditItem {
	id: string;
	actorUserId: string | null;
	action: string;
	targetType: string;
	targetId: string;
	createdAt: string;
}

export interface ResolveUncertainSubmissionInput {
	attemptId: string;
	resolution: "ACCEPTED" | "REJECTED";
	providerTaskId?: string;
	statusUrl?: string;
	resultUrl?: string;
	providerEvidenceReference: string;
	actorUserId: string;
	idempotencyKey: string;
	reason: string;
}

const PROVIDER_RECONCILIATION_CAPABILITIES: Record<
	string,
	"TASK_ID" | "TASK_ID_AND_ENDPOINT" | "UNSUPPORTED"
> = {
	replicate: "TASK_ID",
	fal: "TASK_ID_AND_ENDPOINT",
	kie: "TASK_ID",
	gemini: "UNSUPPORTED",
};

export function assertReplayablePersistedEventStatus(
	_kind: PersistedEventKind,
	status: string,
): void {
	if (status !== "RECEIVED" && status !== "FAILED" && status !== "DEAD_LETTER") {
		throw new Error("EVENT_NOT_REPLAYABLE");
	}
}

const RETRYABLE_JOB_STATUS: Record<AdminRetryStage, readonly string[]> = {
	DISPATCH: ["RESERVED", "DISPATCH_QUEUED"],
	FINALIZE: ["FINALIZING"],
	SETTLE: ["FINALIZING", "CANCELED"],
};
const DISPATCH_RECOVERY_CODES = new Set([
	"PROVIDER_ADAPTER_UNAVAILABLE",
	"QUOTED_ROUTE_UNAVAILABLE",
	"LEGACY_QUOTE_ROUTE_UNAVAILABLE",
]);

export function assertRetryableAdminStage(
	stage: AdminRetryStage,
	status: string,
	hasExistingStageEvent = true,
	failureCode?: string | null,
): void {
	if (
		stage === "DISPATCH" &&
		status === "NEEDS_RECONCILIATION" &&
		failureCode &&
		DISPATCH_RECOVERY_CODES.has(failureCode)
	) {
		return;
	}
	if (
		!RETRYABLE_JOB_STATUS[stage].includes(status) ||
		((stage === "FINALIZE" || stage === "SETTLE") && !hasExistingStageEvent)
	) {
		throw new Error("STAGE_NOT_RETRYABLE");
	}
}

export function toSafeAuditItem(record: AuditRecordProjection): SafeAuditItem {
	return {
		id: record.id,
		actorUserId: record.actorUserId,
		action: record.action,
		targetType: record.targetType,
		targetId: record.targetId,
		createdAt: record.createdAt.toISOString(),
	};
}

export async function listAdminMediaAudit(
	input: { limit: number; cursor?: { createdAt: Date; id: string } },
	client: MediaTransactionClient,
) {
	const rows = await client.auditLog.findMany({
		where: {
			OR: [
				{ action: { startsWith: "MEDIA_" } },
				{ action: { startsWith: "RUNTIME_CONFIG_" } },
				{ targetType: { in: ["GENERATION_JOB", "PAYMENT_EVENT", "PROVIDER_WEBHOOK_EVENT"] } },
			],
			...(input.cursor
				? {
						AND: [
							{
								OR: [
									{ createdAt: { lt: input.cursor.createdAt } },
									{ createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
								],
							},
						],
					}
				: {}),
		},
		select: {
			id: true,
			actorUserId: true,
			action: true,
			targetType: true,
			targetId: true,
			createdAt: true,
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: input.limit + 1,
	});
	const hasMore = rows.length > input.limit;
	const items = rows.slice(0, input.limit).map(toSafeAuditItem);
	const last = hasMore ? items[items.length - 1] : undefined;
	return {
		items,
		nextCursor: last
			? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString(
					"base64url",
				)
			: null,
	};
}

function operationAuditId(idempotencyKey: string): string {
	return `operation:${idempotencyKey}`;
}

async function findOperationReplay(
	idempotencyKey: string,
	operationKind: string,
	requestFingerprint: string,
	client: Prisma.TransactionClient,
) {
	return client.auditLog
		.findFirst({
			where: { targetType: "ADMIN_MEDIA_OPERATION", targetId: operationAuditId(idempotencyKey) },
			select: { after: true, metadata: true },
		})
		.then((audit) => {
			if (!audit) return null;
			const metadata = replayResult(audit.metadata);
			if (
				metadata.operationKind !== operationKind ||
				metadata.requestFingerprint !== requestFingerprint
			) {
				throw new Error("IDEMPOTENCY_CONFLICT");
			}
			return audit;
		});
}

function fingerprint(value: Record<string, string | boolean>): string {
	return JSON.stringify(
		Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
	);
}

function replayResult(value: Prisma.JsonValue | null): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export async function requeueAdminMediaVerification(
	input: {
		assetId: string;
		actorUserId: string;
		idempotencyKey: string;
		reason: string;
		currentVerification: {
			provider: string;
			ruleVersion: string;
			policyVersion: string;
		};
	},
	client: MediaTransactionClient,
): Promise<{ assetId: string; generation: number; replayed: boolean }> {
	return client.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-media:${input.idempotencyKey}`}, 0))`;
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${input.assetId}`}, 0))`;
		const requestFingerprint = fingerprint({
			assetId: input.assetId,
			provider: input.currentVerification.provider,
			ruleVersion: input.currentVerification.ruleVersion,
			policyVersion: input.currentVerification.policyVersion,
		});
		const replay = await findOperationReplay(
			input.idempotencyKey,
			"REQUEUE_VERIFICATION",
			requestFingerprint,
			tx,
		);
		if (replay) {
			const result = replayResult(replay.after);
			if (result.assetId !== input.assetId || typeof result.generation !== "number") {
				throw new Error("IDEMPOTENCY_RESULT_INVALID");
			}
			return { assetId: input.assetId, generation: result.generation, replayed: true };
		}
		const asset = await tx.mediaAsset.findUnique({ where: { id: input.assetId } });
		if (!asset || asset.deletedAt !== null) {
			throw new Error("MEDIA_VERIFICATION_NOT_REQUEUEABLE");
		}
		if (asset.kind === "OUTPUT") {
			throw new Error("MEDIA_OUTPUT_VERIFICATION_REQUEUE_FORBIDDEN");
		}
		if (asset.status === "READY") {
			const now = new Date();
			const latestEvidence = await tx.assetModerationResult.findFirst({
				where: {
					assetId: asset.id,
					verificationGeneration: asset.verificationGeneration,
				},
				orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }, { id: "desc" }],
			});
			const contractIsCurrent =
				asset.verificationProvider === input.currentVerification.provider &&
				asset.verificationRuleVersion === input.currentVerification.ruleVersion &&
				asset.verificationPolicyVersion === input.currentVerification.policyVersion;
			const evidenceIsCurrent =
				latestEvidence?.status === "APPROVED" &&
				latestEvidence.attemptNumber === asset.verificationAttemptCount &&
				latestEvidence.assetChecksum === asset.checksum &&
				latestEvidence.evidenceKind === asset.kind &&
				latestEvidence.provider === asset.verificationProvider &&
				latestEvidence.providerTaskId === asset.verificationProviderTaskId &&
				latestEvidence.ruleVersion === asset.verificationRuleVersion &&
				latestEvidence.policyVersion === asset.verificationPolicyVersion &&
				latestEvidence.validUntil !== null &&
				asset.verificationValidUntil !== null &&
				latestEvidence.validUntil.getTime() === asset.verificationValidUntil.getTime() &&
				latestEvidence.validUntil > now;
			if (contractIsCurrent && evidenceIsCurrent) {
				throw new Error("MEDIA_VERIFICATION_NOT_REQUEUEABLE");
			}
		} else if (
			!(["VERIFICATION_FAILED", "QUARANTINED"] as const).includes(
				asset.status as "VERIFICATION_FAILED" | "QUARANTINED",
			)
		) {
			throw new Error("MEDIA_VERIFICATION_NOT_REQUEUEABLE");
		}
		const generation = Math.max(asset.verificationGeneration + 1, 1);
		await tx.mediaAsset.update({
			where: { id: asset.id },
			data: {
				status: "VERIFYING",
				verificationGeneration: generation,
				verificationAttemptCount: 0,
				verificationProvider: null,
				verificationRuleVersion: null,
				verificationPolicyVersion: null,
				verificationProviderTaskId: null,
				verificationLeaseToken: null,
				verificationLeasedUntil: null,
				verificationNextAttemptAt: null,
				verificationDeadlineAt: null,
				verificationExhaustedAt: null,
				verificationValidUntil: null,
				verificationSubmissionToken: null,
				verificationSubmissionUncertain: false,
				verificationSubmittedAt: null,
				verificationLastErrorCode: null,
			},
		});
		await tx.outboxEvent.upsert({
			where: { dedupeKey: `admin-media-verification:${asset.id}:${input.idempotencyKey}` },
			create: {
				eventType: "MEDIA_ASSET_VERIFY",
				aggregateType: "MEDIA_ASSET",
				aggregateId: asset.id,
				dedupeKey: `admin-media-verification:${asset.id}:${input.idempotencyKey}`,
				payload: { assetId: asset.id, verificationGeneration: generation },
			},
			update: {},
		});
		const result = { assetId: asset.id, generation };
		await tx.auditLog.create({
			data: {
				actorUserId: input.actorUserId,
				action: "MEDIA_ASSET_VERIFICATION_REQUEUED",
				targetType: "ADMIN_MEDIA_OPERATION",
				targetId: operationAuditId(input.idempotencyKey),
				before: {
					status: asset.status,
					generation: asset.verificationGeneration,
					attemptCount: asset.verificationAttemptCount,
					exhaustedAt: asset.verificationExhaustedAt?.toISOString() ?? null,
					validUntil: asset.verificationValidUntil?.toISOString() ?? null,
				},
				after: result,
				metadata: {
					reason: input.reason,
					operationKind: "REQUEUE_VERIFICATION",
					requestFingerprint,
					currentVerification: input.currentVerification,
				},
			},
		});
		return { ...result, replayed: false };
	});
}

export async function replayPersistedMediaEvent(
	input: {
		eventKind: PersistedEventKind;
		eventId: string;
		actorUserId: string;
		idempotencyKey: string;
		reason: string;
	},
	client: MediaTransactionClient,
) {
	return client.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-media:${input.idempotencyKey}`}, 0))`;
		const requestFingerprint = fingerprint({ eventId: input.eventId, eventKind: input.eventKind });
		const replay = await findOperationReplay(
			input.idempotencyKey,
			"REPLAY_EVENT",
			requestFingerprint,
			tx,
		);
		if (replay) {
			return { eventId: input.eventId, eventKind: input.eventKind, replayed: true };
		}
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-media:event:${input.eventKind}:${input.eventId}`}, 0))`;
		const paymentEvent =
			input.eventKind === "PAYMENT"
				? await tx.paymentEvent.findUnique({ where: { id: input.eventId } })
				: null;
		const providerEvent =
			input.eventKind === "PROVIDER"
				? await tx.providerWebhookEvent.findUnique({ where: { id: input.eventId } })
				: null;
		const event = paymentEvent ?? providerEvent;
		if (!event) throw new Error("EVENT_NOT_FOUND");
		assertReplayablePersistedEventStatus(input.eventKind, event.status);
		const eventType =
			input.eventKind === "PAYMENT" ? "PAYMENT_EVENT_RECEIVED" : "PROVIDER_EVENT_RECEIVED";
		const active = await tx.outboxEvent.findFirst({
			where: { aggregateId: event.id, eventType, status: { in: ["PENDING", "LEASED"] } },
			select: { id: true },
		});
		if (active) throw new Error("OPERATION_ALREADY_PENDING");
		if (input.eventKind === "PAYMENT") {
			const changed = await tx.paymentEvent.updateMany({
				where: {
					id: event.id,
					status: paymentEvent!.status,
					processedAt: paymentEvent!.processedAt,
					failureReason: paymentEvent!.failureReason,
					attemptCount: paymentEvent!.attemptCount,
					lastTriggerAttempt: paymentEvent!.lastTriggerAttempt,
					lastAttemptAt: paymentEvent!.lastAttemptAt,
					lastTriggerRunId: paymentEvent!.lastTriggerRunId,
					lastErrorClass: paymentEvent!.lastErrorClass,
					processingToken: paymentEvent!.processingToken,
					processingLeasedUntil: paymentEvent!.processingLeasedUntil,
				},
				data: {
					status: "RECEIVED",
					failureReason: null,
					attemptCount: 0,
					lastTriggerAttempt: null,
					lastAttemptAt: null,
					lastTriggerRunId: null,
					lastErrorClass: null,
					processingToken: null,
					processingLeasedUntil: null,
				},
			});
			if (changed.count !== 1) throw new Error("EVENT_NOT_REPLAYABLE");
		} else {
			const changed = await tx.providerWebhookEvent.updateMany({
				where: { id: event.id, status: { in: ["RECEIVED", "FAILED"] }, processingToken: null },
				data: {
					status: "RECEIVED",
					failureReason: null,
					processingToken: null,
					processingLeasedUntil: null,
				},
			});
			if (changed.count !== 1) throw new Error("EVENT_NOT_REPLAYABLE");
		}
		const payloadKey = input.eventKind === "PAYMENT" ? "paymentEventId" : "providerWebhookEventId";
		await tx.outboxEvent.upsert({
			where: { dedupeKey: `admin-replay:${input.eventKind}:${event.id}:${input.idempotencyKey}` },
			create: {
				eventType,
				aggregateType: input.eventKind === "PAYMENT" ? "PAYMENT_EVENT" : "PROVIDER_WEBHOOK_EVENT",
				aggregateId: event.id,
				dedupeKey: `admin-replay:${input.eventKind}:${event.id}:${input.idempotencyKey}`,
				payload: { [payloadKey]: event.id },
			},
			update: {},
		});
		const result = { eventId: event.id, eventKind: input.eventKind };
		await tx.auditLog.create({
			data: {
				actorUserId: input.actorUserId,
				action: "MEDIA_EVENT_REPLAYED",
				targetType: "ADMIN_MEDIA_OPERATION",
				targetId: operationAuditId(input.idempotencyKey),
				...(paymentEvent ? { before: paymentEventReplaySnapshot(paymentEvent) } : {}),
				after: result,
				metadata: { reason: input.reason, operationKind: "REPLAY_EVENT", requestFingerprint },
			},
		});
		return { ...result, replayed: false };
	});
}

function paymentEventReplaySnapshot(event: {
	status: string;
	failureReason: string | null;
	attemptCount: number;
	lastTriggerAttempt: number | null;
	lastAttemptAt: Date | null;
	lastTriggerRunId: string | null;
	lastErrorClass: string | null;
}) {
	return {
		status: event.status,
		failureReason: event.failureReason,
		attemptCount: event.attemptCount,
		lastTriggerAttempt: event.lastTriggerAttempt,
		lastAttemptAt: event.lastAttemptAt?.toISOString() ?? null,
		lastTriggerRunId: event.lastTriggerRunId,
		lastErrorClass: event.lastErrorClass,
	};
}

export async function retryAdminMediaJobStage(
	input: {
		jobId: string;
		stage: AdminRetryStage;
		actorUserId: string;
		idempotencyKey: string;
		reason: string;
	},
	client: MediaTransactionClient,
) {
	return client.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-media:${input.idempotencyKey}`}, 0))`;
		const requestFingerprint = fingerprint({ jobId: input.jobId, stage: input.stage });
		const replay = await findOperationReplay(
			input.idempotencyKey,
			"RETRY_STAGE",
			requestFingerprint,
			tx,
		);
		if (replay) return { jobId: input.jobId, stage: input.stage, replayed: true };
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-media:job-stage:${input.jobId}:${input.stage}`}, 0))`;
		const job = await tx.generationJob.findUnique({
			where: { id: input.jobId },
			include: {
				attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
				reservation: { select: { status: true } },
			},
		});
		if (!job) throw new Error("JOB_NOT_FOUND");
		const existingStageEvent =
			input.stage === "DISPATCH"
				? true
				: Boolean(
						await tx.outboxEvent.findFirst({
							where: {
								aggregateId: job.id,
								eventType:
									input.stage === "FINALIZE"
										? { in: ["GENERATION_FINALIZE", "GENERATION_FINALIZE_RETRY"] }
										: "GENERATION_SETTLE",
							},
							select: { id: true },
						}),
					);
		assertRetryableAdminStage(input.stage, job.status, existingStageEvent, job.failureCode);
		const eventType =
			input.stage === "DISPATCH"
				? "GENERATION_DISPATCH"
				: input.stage === "FINALIZE"
					? "GENERATION_FINALIZE_RETRY"
					: "GENERATION_SETTLE";
		const activeStageEvent = await tx.outboxEvent.findFirst({
			where: {
				aggregateId: job.id,
				eventType:
					input.stage === "FINALIZE"
						? { in: ["GENERATION_FINALIZE", "GENERATION_FINALIZE_RETRY"] }
						: eventType,
				status: { in: ["PENDING", "LEASED"] },
			},
			select: { id: true },
		});
		if (activeStageEvent) throw new Error("OPERATION_ALREADY_PENDING");
		let version = job.version;
		if (input.stage === "DISPATCH" && job.status === "NEEDS_RECONCILIATION") {
			if (job.reservation?.status !== "ACTIVE") {
				throw new Error("UNCERTAIN_RESERVATION_NOT_ACTIVE");
			}
			const attempt = job.attempts[0];
			if (
				attempt &&
				(attempt.status !== "NEEDS_RECONCILIATION" ||
					attempt.uncertainSubmission ||
					attempt.providerTaskId)
			) {
				throw new Error("STAGE_NOT_RETRYABLE");
			}
			const restored = await tx.generationJob.updateMany({
				where: {
					id: job.id,
					status: "NEEDS_RECONCILIATION",
					failureCode: { in: [...DISPATCH_RECOVERY_CODES] },
				},
				data: {
					status: "DISPATCH_QUEUED",
					failureCode: null,
					version: { increment: 1 },
				},
			});
			if (restored.count !== 1) throw new Error("STAGE_NOT_RETRYABLE");
			if (attempt) {
				const attemptRestored = await tx.generationAttempt.updateMany({
					where: {
						id: attempt.id,
						status: "NEEDS_RECONCILIATION",
						uncertainSubmission: false,
						providerTaskId: null,
					},
					data: {
						status: "CREATED",
						errorSnapshot: {},
						submittedAt: null,
						nextReconcileAt: null,
					},
				});
				if (attemptRestored.count !== 1) {
					throw new Error("STAGE_NOT_RETRYABLE");
				}
			}
			version += 1;
		}
		await tx.outboxEvent.upsert({
			where: { dedupeKey: `admin-stage:${job.id}:${input.stage}:${input.idempotencyKey}` },
			create: {
				eventType,
				aggregateType: "GENERATION_JOB",
				aggregateId: job.id,
				dedupeKey: `admin-stage:${job.id}:${input.stage}:${input.idempotencyKey}`,
				payload: { jobId: job.id, version },
			},
			update: {},
		});
		const result = { jobId: job.id, stage: input.stage };
		await tx.auditLog.create({
			data: {
				actorUserId: input.actorUserId,
				action: "MEDIA_JOB_STAGE_RETRIED",
				targetType: "ADMIN_MEDIA_OPERATION",
				targetId: operationAuditId(input.idempotencyKey),
				after: result,
				metadata: { reason: input.reason, operationKind: "RETRY_STAGE", requestFingerprint },
			},
		});
		return { ...result, replayed: false };
	});
}

export async function resolveAdminUncertainSubmission(
	input: ResolveUncertainSubmissionInput,
	client: MediaTransactionClient,
) {
	if (!input.providerEvidenceReference.trim()) {
		throw new Error("PROVIDER_EVIDENCE_REQUIRED");
	}
	if (input.resolution === "ACCEPTED" && !input.providerTaskId) {
		throw new Error("PROVIDER_TASK_ID_REQUIRED");
	}
	if (
		input.resolution === "REJECTED" &&
		(input.providerTaskId || input.statusUrl || input.resultUrl)
	) {
		throw new Error("REJECTED_SUBMISSION_CANNOT_BIND_PROVIDER_TASK");
	}
	return client.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-media:${input.idempotencyKey}`}, 0))`;
		const requestFingerprint = fingerprint({
			attemptId: input.attemptId,
			resolution: input.resolution,
			providerTaskId: input.providerTaskId ?? "",
			statusUrl: input.statusUrl ?? "",
			resultUrl: input.resultUrl ?? "",
			providerEvidenceReference: input.providerEvidenceReference,
		});
		const replay = await findOperationReplay(
			input.idempotencyKey,
			"RESOLVE_UNCERTAIN_SUBMISSION",
			requestFingerprint,
			tx,
		);
		if (replay) {
			return {
				attemptId: input.attemptId,
				resolution: input.resolution,
				replayed: true,
			};
		}

		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-media:uncertain-attempt:${input.attemptId}`}, 0))`;
		const attempt = await tx.generationAttempt.findUnique({
			where: { id: input.attemptId },
			include: { job: { include: { reservation: true } } },
		});
		if (!attempt) throw new Error("ATTEMPT_NOT_FOUND");
		if (
			attempt.status !== "NEEDS_RECONCILIATION" ||
			attempt.job.status !== "NEEDS_RECONCILIATION" ||
			!attempt.uncertainSubmission
		) {
			throw new Error("ATTEMPT_NOT_AWAITING_RECONCILIATION");
		}
		if (!attempt.job.reservation || attempt.job.reservation.status !== "ACTIVE") {
			throw new Error("UNCERTAIN_RESERVATION_NOT_ACTIVE");
		}
		const reconciliationCapability = PROVIDER_RECONCILIATION_CAPABILITIES[attempt.provider];
		if (
			input.resolution === "ACCEPTED" &&
			(!reconciliationCapability || reconciliationCapability === "UNSUPPORTED")
		) {
			throw new Error("PROVIDER_ACCEPTANCE_CANNOT_BE_RECONCILED");
		}
		if (input.resolution === "ACCEPTED" && reconciliationCapability === "TASK_ID_AND_ENDPOINT") {
			const endpoints = [input.statusUrl, input.resultUrl].filter(
				(endpoint): endpoint is string => endpoint !== undefined,
			);
			if (endpoints.length === 0) throw new Error("FAL_RECONCILIATION_ENDPOINT_REQUIRED");
			for (const endpoint of endpoints) {
				if (!isSafeFalReconciliationEndpoint(endpoint)) {
					throw new Error("UNSAFE_FAL_RECONCILIATION_ENDPOINT");
				}
			}
		}

		if (input.resolution === "ACCEPTED") {
			await tx.generationAttempt.update({
				where: { id: attempt.id },
				data: {
					providerTaskId: input.providerTaskId,
					providerStatusUrl: input.statusUrl,
					providerResultUrl: input.resultUrl,
					status: "SUBMITTED",
					uncertainSubmission: false,
					errorSnapshot: {
						code: "SUBMISSION_ACCEPTED_CONFIRMED_BY_ADMIN",
						providerEvidenceReference: input.providerEvidenceReference,
					},
					nextReconcileAt: new Date(),
				},
			});
			await tx.generationJob.update({
				where: { id: attempt.jobId },
				data: { status: "PROVIDER_PENDING", failureCode: null, version: { increment: 1 } },
			});
		} else {
			await tx.generationAttempt.update({
				where: { id: attempt.id },
				data: {
					status: "FAILED",
					uncertainSubmission: false,
					errorSnapshot: {
						code: "SUBMISSION_REJECTED_CONFIRMED_BY_ADMIN",
						providerEvidenceReference: input.providerEvidenceReference,
					},
					completedAt: new Date(),
				},
			});
			const job = await tx.generationJob.update({
				where: { id: attempt.jobId },
				data: {
					status: "FINALIZING",
					failureCode: "SUBMISSION_REJECTED_CONFIRMED",
					version: { increment: 1 },
				},
			});
			await tx.outboxEvent.upsert({
				where: { dedupeKey: `generation-settle:${attempt.jobId}` },
				create: {
					eventType: "GENERATION_SETTLE",
					aggregateType: "GENERATION_JOB",
					aggregateId: attempt.jobId,
					dedupeKey: `generation-settle:${attempt.jobId}`,
					payload: { jobId: attempt.jobId, version: job.version },
				},
				update: {},
			});
		}

		const result = {
			attemptId: attempt.id,
			jobId: attempt.jobId,
			resolution: input.resolution,
			providerTaskId: input.providerTaskId ?? null,
		};
		await tx.auditLog.create({
			data: {
				actorUserId: input.actorUserId,
				action: `MEDIA_UNCERTAIN_SUBMISSION_${input.resolution}`,
				targetType: "ADMIN_MEDIA_OPERATION",
				targetId: operationAuditId(input.idempotencyKey),
				after: result,
				metadata: {
					reason: input.reason,
					providerEvidenceReference: input.providerEvidenceReference,
					operationKind: "RESOLVE_UNCERTAIN_SUBMISSION",
					requestFingerprint,
				},
			},
		});
		return { ...result, replayed: false };
	});
}

export function isSafeFalReconciliationEndpoint(value: string): boolean {
	if (value !== value.trim()) return false;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	const authority = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value)?.[1];
	return !(
		parsed.protocol !== "https:" ||
		!authority ||
		authority.toLowerCase() !== parsed.hostname ||
		parsed.hostname !== "queue.fal.run" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.port !== ""
	);
}

export async function setAdminMediaRuntimeOverride(
	input: {
		configKey: string;
		value: boolean;
		actorUserId: string;
		idempotencyKey: string;
		reason: string;
	},
	client: MediaTransactionClient,
) {
	return client.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-media:${input.idempotencyKey}`}, 0))`;
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('runtime_config_override_version'))`;
		const requestFingerprint = fingerprint({ configKey: input.configKey, enabled: input.value });
		const replay = await findOperationReplay(
			input.idempotencyKey,
			"SET_OVERRIDE",
			requestFingerprint,
			tx,
		);
		if (replay) {
			const stored = replayResult(replay.after);
			return {
				id: String(stored.id),
				configKey: input.configKey,
				enabled: input.value,
				version: Number(stored.version),
				replayed: true,
			};
		}
		await tx.runtimeConfigOverride.updateMany({
			where: { configKey: input.configKey, active: true },
			data: { active: false, revertedAt: new Date(), revertedByUserId: input.actorUserId },
		});
		const [next] = await tx.$queryRaw<Array<{ version: number }>>`
			SELECT COALESCE(MAX("version"), 0)::int + 1 AS "version" FROM "runtime_config_override"`;
		const created = await tx.runtimeConfigOverride.create({
			data: {
				configKey: input.configKey,
				version: next!.version,
				value: input.value,
				reason: input.reason,
				createdByUserId: input.actorUserId,
			},
		});
		const result = {
			id: created.id,
			configKey: created.configKey,
			enabled: input.value,
			version: created.version,
		};
		await tx.auditLog.create({
			data: {
				actorUserId: input.actorUserId,
				action: "MEDIA_RUNTIME_OVERRIDE_CREATED",
				targetType: "ADMIN_MEDIA_OPERATION",
				targetId: operationAuditId(input.idempotencyKey),
				after: result,
				metadata: { reason: input.reason, operationKind: "SET_OVERRIDE", requestFingerprint },
			},
		});
		return { ...result, replayed: false };
	});
}

export async function rollbackAdminMediaRuntimeOverride(
	input: { overrideId: string; actorUserId: string; idempotencyKey: string; reason: string },
	client: MediaTransactionClient,
) {
	return client.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-media:${input.idempotencyKey}`}, 0))`;
		const requestFingerprint = fingerprint({ overrideId: input.overrideId });
		const replay = await findOperationReplay(
			input.idempotencyKey,
			"ROLLBACK_OVERRIDE",
			requestFingerprint,
			tx,
		);
		if (replay) {
			const stored = replayResult(replay.after);
			return {
				id: input.overrideId,
				configKey: String(stored.configKey),
				version: Number(stored.version),
				replayed: true,
			};
		}
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-media:override:${input.overrideId}`}, 0))`;
		const override = await tx.runtimeConfigOverride.findUnique({ where: { id: input.overrideId } });
		if (!override) throw new Error("OVERRIDE_NOT_FOUND");
		if (!override.active) throw new Error("OVERRIDE_ALREADY_INACTIVE");
		const changed = await tx.runtimeConfigOverride.updateMany({
			where: { id: override.id, active: true },
			data: {
				active: false,
				revertedAt: new Date(),
				revertedByUserId: input.actorUserId,
			},
		});
		if (changed.count !== 1) throw new Error("OVERRIDE_ALREADY_INACTIVE");
		const result = { id: override.id, configKey: override.configKey, version: override.version };
		await tx.auditLog.create({
			data: {
				actorUserId: input.actorUserId,
				action: "MEDIA_RUNTIME_OVERRIDE_ROLLED_BACK",
				targetType: "ADMIN_MEDIA_OPERATION",
				targetId: operationAuditId(input.idempotencyKey),
				after: result,
				metadata: { reason: input.reason, operationKind: "ROLLBACK_OVERRIDE", requestFingerprint },
			},
		});
		return { ...result, replayed: false };
	});
}
