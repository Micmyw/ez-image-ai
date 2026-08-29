import { createHash } from "node:crypto";

import type { Prisma } from "../../generated/client";
import { releaseCreditsInTransaction, reserveCreditsInTransaction } from "./credits";
import { ACTIVE_GENERATION_JOB_STATUSES } from "./state-machine";
import type { MediaTransactionClient } from "./types";

const GUEST_UNDISPATCHED_TTL_MS = 10 * 60_000;

export interface GuestQueueEstimateInput {
	now: Date;
	queueDepth: number;
	queueCapacity: number;
	serviceTimeMs: number;
	immutableExpiry: Date;
}

export function deriveGuestQueueEstimate(input: GuestQueueEstimateInput): {
	projectedDispatchAt: Date;
	estimateExpiresAt: Date;
} | null {
	if (
		Number.isNaN(input.now.getTime()) ||
		Number.isNaN(input.immutableExpiry.getTime()) ||
		!Number.isSafeInteger(input.queueDepth) ||
		input.queueDepth < 0 ||
		!Number.isSafeInteger(input.queueCapacity) ||
		input.queueCapacity <= 0 ||
		!Number.isSafeInteger(input.serviceTimeMs) ||
		input.serviceTimeMs <= 0
	) {
		throw new Error("GUEST_QUEUE_ESTIMATE_INVALID");
	}
	const waves = Math.ceil(input.queueDepth / input.queueCapacity);
	const queueDelayMs = waves * input.serviceTimeMs;
	if (!Number.isSafeInteger(queueDelayMs)) throw new Error("GUEST_QUEUE_ESTIMATE_INVALID");
	const projectedDispatchAt = new Date(input.now.getTime() + queueDelayMs);
	if (projectedDispatchAt.getTime() >= input.immutableExpiry.getTime()) return null;
	return {
		projectedDispatchAt,
		estimateExpiresAt: new Date(
			Math.min(
				projectedDispatchAt.getTime() + input.serviceTimeMs,
				input.immutableExpiry.getTime(),
			),
		),
	};
}

export interface ExpireGuestMediaInput {
	now: Date;
	limit: number;
}

export interface ExpireGuestMediaResult {
	expiredAssets: number;
	expiredJobs: number;
	cleanupEvents: number;
	removedAnonymousUsers: number;
}

export async function expireGuestMediaTransaction(
	input: ExpireGuestMediaInput,
	client: MediaTransactionClient,
): Promise<ExpireGuestMediaResult> {
	assertExpiryInput(input);
	return client.$transaction(
		async (tx) => {
			const assetResult = await expireDueGuestAssets(input, tx);
			const expiredJobs = await expireUndispatchedGuestJobs(input, tx);
			const removedAnonymousUsers = await removeExpiredGuestPrincipals(input, tx);
			return {
				expiredAssets: assetResult.expiredAssets,
				expiredJobs,
				cleanupEvents: assetResult.cleanupEvents,
				removedAnonymousUsers,
			};
		},
		{ isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 20_000 },
	);
}

async function expireDueGuestAssets(
	input: ExpireGuestMediaInput,
	tx: Prisma.TransactionClient,
): Promise<{ expiredAssets: number; cleanupEvents: number }> {
	const due = await tx.$queryRaw<Array<{ id: string }>>`
		SELECT "id"
		FROM "media_asset"
		WHERE "retentionClass" = 'GUEST_TRIAL'::"MediaRetentionClass"
		  AND "deleteAfter" <= ${input.now}
		  AND ("status" <> 'DELETED'::"MediaAssetStatus" OR "deletedAt" IS NULL)
		ORDER BY "deleteAfter" ASC, "createdAt" ASC, "id" ASC
		FOR UPDATE SKIP LOCKED
		LIMIT ${input.limit}
	`;
	let expiredAssets = 0;
	let cleanupEvents = 0;
	for (const { id } of due) {
		const asset = await tx.mediaAsset.findUniqueOrThrow({
			where: { id },
			include: { uploadSessions: { orderBy: { createdAt: "asc" } } },
		});
		const changed = await tx.mediaAsset.updateMany({
			where: {
				id: asset.id,
				retentionClass: "GUEST_TRIAL",
				deleteAfter: { lte: input.now },
			},
			data: {
				status: "DELETED",
				deletedAt: asset.deletedAt ?? input.now,
				verificationValidUntil: null,
				verificationNextAttemptAt: null,
				verificationLeaseToken: null,
				verificationLeasedUntil: null,
				outputTransferToken: null,
				outputTransferLeaseExpiresAt: null,
				outputStagingObjectKey: null,
				outputPromotionMultipartUploadId: null,
			},
		});
		if (changed.count !== 1) continue;
		expiredAssets += 1;
		cleanupEvents += await queueGuestAssetCleanup(asset, input.now, tx);
	}
	return { expiredAssets, cleanupEvents };
}

async function queueGuestAssetCleanup(
	asset: Prisma.MediaAssetGetPayload<{ include: { uploadSessions: true } }>,
	now: Date,
	tx: Prisma.TransactionClient,
): Promise<number> {
	const uploadSession = asset.uploadSessions[0];
	const stagingObjectKey = uploadSession?.stagingObjectKey ?? asset.outputStagingObjectKey;
	let cleanupEvents = 0;

	cleanupEvents += await queueGuestCleanupEvent(
		{
			eventType: "MEDIA_OBJECT_DELETE",
			dedupeKey: guestObjectCleanupDedupeKey(asset.id, "delete", asset.objectKey),
			payload: {
				assetId: asset.id,
				objectKey: asset.objectKey,
				...(uploadSession
					? { uploadSessionId: uploadSession.id, reservationStatus: "RELEASED" }
					: asset.kind === "OUTPUT"
						? { storageReservationReferenceKey: `generation-output:${asset.id}` }
						: {}),
			},
		},
		asset.id,
		now,
		tx,
	);

	if (stagingObjectKey) {
		const multipartUploadId = uploadSession?.multipartUploadId;
		cleanupEvents += await queueGuestCleanupEvent(
			{
				eventType: multipartUploadId ? "MEDIA_MULTIPART_ABORT" : "MEDIA_OBJECT_DELETE",
				dedupeKey: guestObjectCleanupDedupeKey(
					asset.id,
					multipartUploadId ? `multipart-${multipartUploadId}` : "delete",
					stagingObjectKey,
				),
				payload: {
					assetId: asset.id,
					objectKey: stagingObjectKey,
					...(multipartUploadId ? { multipartUploadId } : {}),
				},
			},
			asset.id,
			now,
			tx,
		);
	}

	const promotionMultipartUploadId =
		uploadSession?.promotionMultipartUploadId ?? asset.outputPromotionMultipartUploadId;
	if (promotionMultipartUploadId) {
		cleanupEvents += await queueGuestCleanupEvent(
			{
				eventType: "MEDIA_UPLOAD_CLEANUP",
				dedupeKey: guestObjectCleanupDedupeKey(
					asset.id,
					`promotion-${promotionMultipartUploadId}`,
					asset.objectKey,
				),
				payload: {
					assetId: asset.id,
					objectKey: asset.objectKey,
					multipartUploadId: promotionMultipartUploadId,
					promotionAbortOnly: true,
				},
			},
			asset.id,
			now,
			tx,
		);
	}

	return cleanupEvents;
}

async function queueGuestCleanupEvent(
	event: { eventType: string; dedupeKey: string; payload: Prisma.InputJsonValue },
	assetId: string,
	now: Date,
	tx: Prisma.TransactionClient,
): Promise<number> {
	const result = await tx.outboxEvent.createMany({
		data: [
			{
				eventType: event.eventType,
				aggregateType: "MEDIA_ASSET",
				aggregateId: assetId,
				dedupeKey: event.dedupeKey,
				payload: event.payload,
				availableAt: now,
			},
		],
		skipDuplicates: true,
	});
	return result.count;
}

function guestObjectCleanupDedupeKey(assetId: string, action: string, objectKey: string): string {
	return `guest-retention-${action}:${assetId}:${guestCleanupObjectFingerprint(objectKey)}`;
}

async function expireUndispatchedGuestJobs(
	input: ExpireGuestMediaInput,
	tx: Prisma.TransactionClient,
): Promise<number> {
	const cutoff = new Date(input.now.getTime() - GUEST_UNDISPATCHED_TTL_MS);
	const due = await tx.$queryRaw<Array<{ id: string }>>`
		SELECT job."id"
		FROM "generation_job" job
		WHERE job."serviceClass" = 'GUEST_SLOW'::"GenerationServiceClass"
		  AND job."status" IN ('RESERVED'::"GenerationJobStatus", 'DISPATCH_QUEUED'::"GenerationJobStatus")
		  AND job."createdAt" <= ${cutoff}
		  AND NOT EXISTS (
			SELECT 1 FROM "generation_attempt" attempt WHERE attempt."jobId" = job."id"
		  )
		ORDER BY job."createdAt" ASC, job."id" ASC
		FOR UPDATE OF job SKIP LOCKED
		LIMIT ${input.limit}
	`;
	let expired = 0;
	for (const { id } of due) {
		const result = await expireGuestJobBeforeProvider({ jobId: id, now: input.now }, tx);
		if (result.outcome !== "SKIPPED") expired += 1;
	}
	return expired;
}

export async function expireGuestJobBeforeProvider(
	input: {
		jobId: string;
		now: Date;
		createReplacement?: boolean;
		queueCapacity?: number;
		serviceTimeMs?: number;
	},
	tx: Prisma.TransactionClient,
): Promise<
	{ outcome: "SKIPPED" } | { outcome: "EXPIRED"; jobId: string; replacementJobId?: string }
> {
	const job = await tx.generationJob.findUnique({
		where: { id: input.jobId },
		include: {
			attempts: { take: 1 },
			assets: true,
			quote: true,
			reservation: true,
			guestTrial: { include: { linkIntents: { select: { state: true } } } },
		},
	});
	const trial = job?.guestTrial;
	if (
		!job ||
		!trial ||
		job.serviceClass !== "GUEST_SLOW" ||
		!(["RESERVED", "DISPATCH_QUEUED"] as string[]).includes(job.status) ||
		job.attempts.length !== 0 ||
		trial.currentJobId !== job.id ||
		trial.consumedJobId !== null ||
		trial.riskState !== "HELD"
	) {
		return { outcome: "SKIPPED" };
	}
	if (!job.reservation || job.reservation.status !== "ACTIVE") {
		throw new Error("GUEST_RESERVATION_UNAVAILABLE");
	}
	await releaseCreditsInTransaction(
		{
			reservationId: job.reservation.id,
			referenceKey: `guest-job:${job.id}:queue-expired:release`,
		},
		tx,
	);
	await tx.generationJob.update({
		where: { id: job.id },
		data: {
			status: "FAILED",
			failureCode: "GUEST_QUEUE_EXPIRED",
			terminalAt: input.now,
			version: { increment: 1 },
		},
	});

	const replacementAllowed =
		input.createReplacement !== false &&
		trial.replacementCount === 0 &&
		trial.expiresAt > input.now &&
		trial.linkedAt === null &&
		trial.linkIntents.every((intent) => intent.state === "NONE");
	if (replacementAllowed) {
		const replacement = await createGuestReplacement(job, trial, input, tx);
		if (replacement) {
			return { outcome: "EXPIRED", jobId: job.id, replacementJobId: replacement.id };
		}
	}

	await releaseGuestRisk(trial, tx);
	await tx.guestMediaTrial.update({
		where: { id: trial.id },
		data: {
			currentJobId: null,
			eligibility: trial.expiresAt <= input.now ? "EXPIRED" : "AVAILABLE",
			riskState: "RELEASED",
			terminalAt: input.now,
		},
	});
	return { outcome: "EXPIRED", jobId: job.id };
}

async function createGuestReplacement(
	job: Prisma.GenerationJobGetPayload<{
		include: {
			attempts: true;
			assets: true;
			quote: true;
			reservation: true;
			guestTrial: { include: { linkIntents: { select: { state: true } } } };
		};
	}>,
	trial: NonNullable<typeof job.guestTrial>,
	input: {
		now: Date;
		queueCapacity?: number;
		serviceTimeMs?: number;
	},
	tx: Prisma.TransactionClient,
) {
	const queueDepth = await tx.generationJob.count({
		where: {
			serviceClass: "GUEST_SLOW",
			id: { not: job.id },
			status: { in: [...ACTIVE_GENERATION_JOB_STATUSES] },
		},
	});
	const persistedServiceTimeMs = Math.max(
		1,
		trial.estimateExpiresAt.getTime() - trial.projectedDispatchAt.getTime(),
	);
	const estimate = deriveGuestQueueEstimate({
		now: input.now,
		queueDepth,
		queueCapacity: input.queueCapacity ?? 1,
		serviceTimeMs: input.serviceTimeMs ?? persistedServiceTimeMs,
		immutableExpiry: trial.expiresAt,
	});
	if (!estimate) return null;
	const quote = await tx.generationQuote.create({
		data: {
			ownerType: job.quote.ownerType,
			ownerId: job.quote.ownerId,
			submittedByUserId: job.quote.submittedByUserId,
			productKey: job.quote.productKey,
			catalogVersion: job.quote.catalogVersion,
			pricingVersion: job.quote.pricingVersion,
			credits: job.quote.credits,
			costMicros: job.quote.costMicros,
			inputSnapshot: job.quote.inputSnapshot as Prisma.InputJsonValue,
			pricingSnapshot: job.quote.pricingSnapshot as Prisma.InputJsonValue,
			moderationDecision: job.quote.moderationDecision,
			moderationProvider: job.quote.moderationProvider,
			moderationRuleVersion: job.quote.moderationRuleVersion,
			moderationReasonCode: job.quote.moderationReasonCode,
			inputFingerprint: job.quote.inputFingerprint,
			expiresAt: trial.expiresAt,
		},
	});
	const replacement = await tx.generationJob.create({
		data: {
			ownerType: job.ownerType,
			ownerId: job.ownerId,
			submittedByUserId: job.submittedByUserId,
			quoteId: quote.id,
			idempotencyKey: `${job.idempotencyKey}:replacement-1`,
			productKey: job.productKey,
			catalogVersion: job.catalogVersion,
			pricingVersion: job.pricingVersion,
			creditsReserved: job.creditsReserved,
			inputSnapshot: job.inputSnapshot as Prisma.InputJsonValue,
			pricingSnapshot: job.pricingSnapshot as Prisma.InputJsonValue,
			serviceClass: "GUEST_SLOW",
			dispatchEligibleAt: estimate.projectedDispatchAt,
			guestTrialId: trial.id,
		},
	});
	const account = await tx.creditAccount.findUniqueOrThrow({
		where: { ownerType_ownerId: { ownerType: "USER", ownerId: job.ownerId } },
	});
	await reserveCreditsInTransaction(
		{
			accountId: account.id,
			jobId: replacement.id,
			amount: job.creditsReserved,
			referenceKey: `job:${replacement.id}:reserve`,
		},
		tx,
	);
	if (job.assets.length) {
		await tx.generationJobAsset.createMany({
			data: job.assets.map((binding) => ({
				jobId: replacement.id,
				assetId: binding.assetId,
				assetChecksum: binding.assetChecksum,
				role: binding.role,
				position: binding.position,
			})),
		});
	}
	await tx.guestMediaTrial.update({
		where: { id: trial.id },
		data: {
			replacementCount: 1,
			currentJobId: replacement.id,
			eligibility: "IN_FLIGHT",
			riskState: "HELD",
			projectedDispatchAt: estimate.projectedDispatchAt,
			estimateExpiresAt: estimate.estimateExpiresAt,
			terminalAt: null,
		},
	});
	await tx.outboxEvent.create({
		data: {
			eventType: "GUEST_GENERATION_ELIGIBLE",
			aggregateType: "GENERATION_JOB",
			aggregateId: replacement.id,
			dedupeKey: `guest-job:${replacement.id}:eligible`,
			payload: { jobId: replacement.id, trialId: trial.id },
			availableAt: estimate.projectedDispatchAt,
		},
	});
	return replacement;
}

async function releaseGuestRisk(
	trial: { promotionPeriod: string; frozenQuotedRiskMicros: bigint; riskState: string },
	tx: Prisma.TransactionClient,
): Promise<void> {
	if (trial.riskState !== "HELD") return;
	const released = await tx.guestRiskBudgetBucket.updateMany({
		where: {
			promotionPeriod: trial.promotionPeriod,
			subjectHash: "global",
			reservedMicros: { gte: trial.frozenQuotedRiskMicros },
		},
		data: {
			reservedMicros: { decrement: trial.frozenQuotedRiskMicros },
			version: { increment: 1 },
		},
	});
	if (released.count !== 1) throw new Error("GUEST_RISK_RESERVATION_UNAVAILABLE");
}

async function removeExpiredGuestPrincipals(
	input: ExpireGuestMediaInput,
	tx: Prisma.TransactionClient,
): Promise<number> {
	const ownerCandidates = await tx.$queryRaw<Array<{ id: string }>>`
		SELECT candidate."id"
		FROM "user" candidate
		WHERE candidate."isAnonymous" = true
		  AND (
			EXISTS (
				SELECT 1
				FROM "guest_session_bootstrap" bootstrap
				WHERE bootstrap."ownerId" = candidate."id"
				  AND bootstrap."expiresAt" <= ${input.now}
			)
			OR EXISTS (
				SELECT 1
				FROM "guest_media_trial" trial
				WHERE trial."ownerId" = candidate."id"
				  AND trial."expiresAt" <= ${input.now}
			)
			OR EXISTS (
				SELECT 1
				FROM "guest_link_intent" intent
				WHERE intent."anonymousOwnerId" = candidate."id"
				  AND intent."expiresAt" <= ${input.now}
			)
		  )
		  AND NOT EXISTS (
			SELECT 1 FROM "session" session
			WHERE session."userId" = candidate."id" AND session."expiresAt" > ${input.now}
		  )
		  AND NOT EXISTS (
			SELECT 1 FROM "guest_session_bootstrap" bootstrap
			WHERE bootstrap."ownerId" = candidate."id" AND bootstrap."expiresAt" > ${input.now}
		  )
		  AND NOT EXISTS (
			SELECT 1 FROM "guest_link_intent" intent
			WHERE intent."anonymousOwnerId" = candidate."id" AND intent."expiresAt" > ${input.now}
		  )
		  AND NOT EXISTS (
			SELECT 1 FROM "guest_media_trial" trial
			WHERE trial."ownerId" = candidate."id" AND trial."expiresAt" > ${input.now}
		  )
		  AND NOT EXISTS (
			SELECT 1
			FROM "guest_media_trial" trial
			JOIN "media_asset" asset ON asset."id" = trial."sourceAssetId"
			WHERE trial."ownerId" = candidate."id"
			  AND (
				asset."status" <> 'DELETED'::"MediaAssetStatus"
				OR asset."deletedAt" IS NULL
				OR EXISTS (
					SELECT 1 FROM "outbox_event" cleanup
					WHERE cleanup."aggregateId" = asset."id"
					  AND cleanup."eventType" IN (
						'MEDIA_OBJECT_DELETE',
						'MEDIA_MULTIPART_ABORT',
						'MEDIA_UPLOAD_CLEANUP'
					  )
					  AND cleanup."status" <> 'PROCESSED'::"OutboxEventStatus"
				)
			  )
		  )
		  AND NOT EXISTS (
			SELECT 1
			FROM "guest_media_trial" trial
			JOIN "generation_job" job ON job."guestTrialId" = trial."id"
			JOIN "generation_job_asset" binding ON binding."jobId" = job."id"
			JOIN "media_asset" asset ON asset."id" = binding."assetId"
			WHERE trial."ownerId" = candidate."id"
			  AND (
				asset."status" <> 'DELETED'::"MediaAssetStatus"
				OR asset."deletedAt" IS NULL
				OR EXISTS (
					SELECT 1 FROM "outbox_event" cleanup
					WHERE cleanup."aggregateId" = asset."id"
					  AND cleanup."eventType" IN (
						'MEDIA_OBJECT_DELETE',
						'MEDIA_MULTIPART_ABORT',
						'MEDIA_UPLOAD_CLEANUP'
					  )
					  AND cleanup."status" <> 'PROCESSED'::"OutboxEventStatus"
				)
			  )
		  )
		ORDER BY candidate."createdAt" ASC, candidate."id" ASC
		FOR UPDATE OF candidate SKIP LOCKED
		LIMIT ${input.limit}
	`;

	await tx.guestResultAccessGrant.deleteMany({ where: { expiresAt: { lte: input.now } } });
	await tx.guestLinkIntent.deleteMany({ where: { expiresAt: { lte: input.now } } });
	await tx.guestSessionBootstrap.deleteMany({ where: { expiresAt: { lte: input.now } } });
	await tx.session.deleteMany({
		where: { expiresAt: { lte: input.now }, user: { isAnonymous: true } },
	});
	await tx.guestAbuseBucket.deleteMany({ where: { expiresAt: { lte: input.now } } });
	await tx.guestRiskBudgetBucket.deleteMany({ where: { expiresAt: { lte: input.now } } });
	await scrubDueTrialAbuseEvidence(input, tx);

	let removed = 0;
	for (const { id: ownerId } of ownerCandidates) {
		const deleted = await tx.user.deleteMany({
			where: {
				id: ownerId,
				isAnonymous: true,
				sessions: { none: {} },
				guestLinkAnonymousOwners: { none: {} },
				guestSessionBootstraps: { none: {} },
				guestMediaTrials: { every: { expiresAt: { lte: input.now } } },
			},
		});
		removed += deleted.count;
	}
	return removed;
}

async function scrubDueTrialAbuseEvidence(
	input: ExpireGuestMediaInput,
	tx: Prisma.TransactionClient,
): Promise<void> {
	const dueTrialIds = await selectDueEvidenceTrialIdsWithSkipLocked(input, tx);
	if (dueTrialIds.length === 0) return;
	await tx.guestMediaTrial.updateMany({
		where: {
			id: { in: dueTrialIds },
			abuseEvidenceDeletedAt: null,
		},
		data: {
			sourceSessionHash: null,
			deviceHash: null,
			ipHash: null,
			subnetHash: null,
			idempotencyFingerprint: null,
			abuseEvidenceDeletedAt: input.now,
		},
	});
}

async function selectDueEvidenceTrialIdsWithSkipLocked(
	input: ExpireGuestMediaInput,
	tx: Prisma.TransactionClient,
): Promise<string[]> {
	const due = await tx.$queryRaw<Array<{ id: string }>>`
		SELECT "id"
		FROM "guest_media_trial"
		WHERE "abuseEvidenceDeletedAt" IS NULL
		  AND "abuseEvidenceExpiresAt" <= ${input.now}
		ORDER BY "abuseEvidenceExpiresAt" ASC, "id" ASC
		FOR UPDATE SKIP LOCKED
		LIMIT ${input.limit}
	`;
	return due.map(({ id }) => id);
}

function assertExpiryInput(input: ExpireGuestMediaInput): void {
	if (Number.isNaN(input.now.getTime())) throw new Error("Guest expiry cutoff is invalid");
	if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 500) {
		throw new Error("Guest expiry limit is invalid");
	}
}

export function guestCleanupObjectFingerprint(objectKey: string): string {
	return createHash("sha256").update(objectKey).digest("base64url").slice(0, 16);
}
