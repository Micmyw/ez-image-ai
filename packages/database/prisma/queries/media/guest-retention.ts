import { createHash } from "node:crypto";

import type { Prisma } from "../../generated/client";
import { releaseCreditsInTransaction, reserveCreditsInTransaction } from "./credits";
import type { MediaTransactionClient } from "./types";

const GUEST_UNDISPATCHED_TTL_MS = 10 * 60_000;
const REPLACEMENT_ESTIMATE_MS = 30_000;

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
	await tx.outboxEvent.upsert({
		where: { dedupeKey: event.dedupeKey },
		create: {
			eventType: event.eventType,
			aggregateType: "MEDIA_ASSET",
			aggregateId: assetId,
			dedupeKey: event.dedupeKey,
			payload: event.payload,
			availableAt: now,
		},
		update: {},
	});
	return 1;
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
	input: { jobId: string; now: Date; createReplacement?: boolean },
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
		const replacement = await createGuestReplacement(job, trial, input.now, tx);
		return { outcome: "EXPIRED", jobId: job.id, replacementJobId: replacement.id };
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
	now: Date,
	tx: Prisma.TransactionClient,
) {
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
			dispatchEligibleAt: now,
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
	const estimateExpiresAt = new Date(
		Math.min(now.getTime() + REPLACEMENT_ESTIMATE_MS, trial.expiresAt.getTime()),
	);
	await tx.guestMediaTrial.update({
		where: { id: trial.id },
		data: {
			replacementCount: 1,
			currentJobId: replacement.id,
			eligibility: "IN_FLIGHT",
			riskState: "HELD",
			projectedDispatchAt: now,
			estimateExpiresAt,
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
			availableAt: now,
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
	await tx.guestResultAccessGrant.deleteMany({ where: { expiresAt: { lte: input.now } } });
	await tx.guestLinkIntent.deleteMany({ where: { expiresAt: { lte: input.now } } });
	await tx.guestSessionBootstrap.deleteMany({ where: { expiresAt: { lte: input.now } } });

	const trials = await tx.guestMediaTrial.findMany({
		where: {
			expiresAt: { lte: input.now },
			currentJobId: null,
			consumedJobId: null,
			jobs: { none: {} },
		},
		orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
		take: input.limit,
		include: {
			jobs: { include: { assets: { select: { assetId: true } } } },
		},
	});
	const ownerCandidates = new Set<string>();
	for (const trial of trials) {
		const assetIds = new Set([
			...(trial.sourceAssetId ? [trial.sourceAssetId] : []),
			...trial.jobs.flatMap((job) => job.assets.map((binding) => binding.assetId)),
		]);
		const [notDeleted, pendingCleanup] = await Promise.all([
			tx.mediaAsset.count({
				where: {
					id: { in: [...assetIds] },
					OR: [{ status: { not: "DELETED" } }, { deletedAt: null }],
				},
			}),
			tx.outboxEvent.count({
				where: {
					aggregateId: { in: [...assetIds] },
					eventType: {
						in: ["MEDIA_OBJECT_DELETE", "MEDIA_MULTIPART_ABORT", "MEDIA_UPLOAD_CLEANUP"],
					},
					status: { not: "PROCESSED" },
				},
			}),
		]);
		if (notDeleted || pendingCleanup) continue;
		ownerCandidates.add(trial.ownerId);
		await tx.guestMediaTrial.delete({ where: { id: trial.id } });
	}

	let removed = 0;
	for (const ownerId of ownerCandidates) {
		const deleted = await tx.user.deleteMany({
			where: {
				id: ownerId,
				isAnonymous: true,
				guestMediaTrials: { none: {} },
				guestLinkAnonymousOwners: { none: {} },
				guestSessionBootstraps: { none: {} },
			},
		});
		removed += deleted.count;
	}
	return removed;
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
