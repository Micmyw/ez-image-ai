import { readVideoInternalFundingSnapshot } from "@repo/config/video-internal-funding";
import {
	isApprovedVideoTextDecision,
	readVideoTextSafetyProfile,
	videoTextSafetyProfilesMatch,
} from "@repo/config/video-text-safety";

import { getDatabaseClient } from "../../client";
import type { Prisma } from "../../generated/client";
import { releaseCreditsInTransaction } from "./credits";
import { runReadCommitted } from "./types";
import { recordVideoTemplateBusinessEvent } from "./video-template-events";
import {
	assertVideoTemplateRoleIdentities,
	getVideoEffectiveInputSnapshot,
} from "./video-template-execution";
import {
	findApprovedVideoTemplateMotionReference,
	isVideoTemplateReference,
} from "./video-template-reference";
import { videoTemplateHasUnsettledScene } from "./video-template-storage";
import { assertVideoPriceApprovalValid } from "./video-v1-price-approval";
import {
	lockVideoOwnerStorage,
	releaseVideoPreOutputCapacity,
	videoOutputReservationBytes,
	videoOutputReservationKey,
} from "./video-v1-storage";

const ENGINE = "video-workflow-v1";
const terminal = new Set(["READY", "FAILED", "REJECTED"]);
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export function getVideoExecutionContext(jobId: string) {
	return getDatabaseClient().generationJob.findFirst({
		where: { id: jobId, executionEngine: ENGINE },
		include: {
			videoExecution: true,
			videoTemplateExecution: { include: { sceneAsset: true } },
			attempts: { orderBy: { attemptNumber: "desc" } },
			assets: { include: { asset: true } },
			reservation: true,
		},
	});
}

async function lockedContext(tx: Prisma.TransactionClient, jobId: string) {
	// Domain writes use ReadCommitted plus this shared lock. Read state only AFTER
	// acquiring it: independent jobs must not conflict through Serializable scans.
	// Existing ledger helpers additionally lock the account and its credit lots.
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`video-v1:${jobId}`}, 0))`;
	await tx.$queryRaw`SELECT "id" FROM "generation_job" WHERE "id" = ${jobId} AND "executionEngine" = ${ENGINE} FOR UPDATE`;
	const job = await tx.generationJob.findFirst({
		where: { id: jobId, executionEngine: ENGINE },
		include: {
			videoExecution: true,
			videoTemplateExecution: { include: { sceneAsset: true } },
			attempts: { orderBy: { attemptNumber: "desc" } },
			assets: { include: { asset: true } },
			reservation: true,
		},
	});
	if (!job?.videoExecution) throw new Error("VIDEO_JOB_NOT_FOUND");
	return job;
}

/** Recheck the sealed object identity inside every side-effect transaction. */
export function assertVideoInputIdentity(
	job: NonNullable<Awaited<ReturnType<typeof getVideoExecutionContext>>>,
) {
	const original = object(job.inputSnapshot);
	if (original.videoEffectTemplate) {
		assertVideoTemplateRoleIdentities(job);
		if (!job.videoTemplateExecution?.resolvedInputIdentity) return;
		const identity = object(job.videoTemplateExecution.resolvedInputIdentity);
		const asset = isVideoTemplateReference(original.videoEffectTemplate)
			? job.assets.find(
					(binding) => binding.role === "INPUT" && binding.assetId === identity.assetId,
				)?.asset
			: job.videoTemplateExecution.sceneAsset;
		if (
			!asset ||
			asset.ownerId !== job.ownerId ||
			asset.ownerType !== job.ownerType ||
			asset.deletedAt ||
			!asset.finalizedAt ||
			asset.status !== "READY" ||
			asset.checksum !== identity.checksum ||
			asset.objectKey !== identity.objectKey ||
			asset.storageEtag !== identity.storageEtag ||
			asset.storageVersionId !== identity.storageVersionId ||
			asset.verificationGeneration !== identity.verificationGeneration ||
			(asset.deleteAfter && asset.deleteAfter <= new Date())
		)
			throw new Error("VIDEO_INPUT_IDENTITY_CHANGED");
		return;
	}
	const snapshot = original;
	if (snapshot.mode === "text-to-video") return;
	const identity = object(snapshot.inputIdentity);
	const binding = job.assets.find(
		(item) => item.role === "INPUT" && item.assetId === identity.assetId,
	);
	const asset = binding?.asset;
	if (
		!asset ||
		asset.ownerType !== job.ownerType ||
		asset.ownerId !== job.ownerId ||
		asset.deletedAt ||
		!asset.finalizedAt ||
		asset.status === "DELETED" ||
		asset.status === "QUARANTINED" ||
		asset.checksum !== identity.checksum ||
		binding?.assetChecksum !== identity.checksum ||
		asset.objectKey !== identity.objectKey ||
		asset.storageEtag !== identity.storageEtag ||
		asset.storageVersionId !== identity.storageVersionId ||
		asset.verificationGeneration !== identity.verificationGeneration ||
		(asset.deleteAfter && asset.deleteAfter <= new Date())
	)
		throw new Error("VIDEO_INPUT_IDENTITY_CHANGED");
}

export async function recordVideoInputReview(jobId: string, patch: Record<string, unknown>) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const job = await lockedContext(tx, jobId);
		if (
			terminal.has(job.videoExecution!.stage) ||
			job.videoExecution!.stage === "NEEDS_REVIEW" ||
			job.attempts.length
		)
			return;
		assertVideoInputIdentity(job);
		await findApprovedVideoTemplateMotionReference(
			object(job.inputSnapshot).videoEffectTemplate,
			tx,
			new Date(),
		);
		const data = object(job.videoExecution!.stageData);
		const review = { ...object(data.inputReview), ...patch };
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stage: "INPUT_REVIEW",
				stateVersion: { increment: 1 },
				lastProgressAt: new Date(),
				inputReviewStartedAt: job.videoExecution!.inputReviewStartedAt ?? new Date(),
				...(review.status === "ALLOW" ? { inputReviewCompletedAt: new Date() } : {}),
				stageData: { ...data, inputReview: review } as Prisma.InputJsonValue,
			},
		});
	});
}

export async function claimVideoImageReview(jobId: string) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const job = await lockedContext(tx, jobId);
		assertVideoInputIdentity(job);
		await findApprovedVideoTemplateMotionReference(
			object(job.inputSnapshot).videoEffectTemplate,
			tx,
			new Date(),
		);
		const data = object(job.videoExecution!.stageData);
		const review = object(data.inputReview);
		if (
			terminal.has(job.videoExecution!.stage) ||
			job.videoExecution!.stage === "NEEDS_REVIEW" ||
			review.imageSubmissionUncertain ||
			review.imageTaskId ||
			review.imageDecision
		)
			return false;
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stateVersion: { increment: 1 },
				stageData: {
					...data,
					inputReview: { ...review, imageSubmissionUncertain: true },
				} as Prisma.InputJsonValue,
			},
		});
		return true;
	});
}

/** Commit the may-have-sent fence BEFORE returning permission for any paid request. */
export async function claimVideoProviderSubmission(input: {
	jobId: string;
	callbackTokenHash: string;
	providerModelId: string;
	ruleVersion: string;
}) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		await lockVideoOwnerStorage(tx, input.jobId);
		const job = await lockedContext(tx, input.jobId);
		const existing = job.attempts[0];
		if (existing) return { attempt: existing, claimed: false };
		if (terminal.has(job.videoExecution!.stage) || job.videoExecution!.stage === "NEEDS_REVIEW")
			throw new Error("VIDEO_JOB_TERMINAL");
		assertVideoInputIdentity(job);
		const effectiveSnapshot = getVideoEffectiveInputSnapshot(job);
		const textSafetyProfile = readVideoTextSafetyProfile(job.inputSnapshot);
		const review = object(object(job.videoExecution!.stageData).inputReview);
		if (
			review.status !== "ALLOW" ||
			review.ruleVersion !== input.ruleVersion ||
			!videoTextSafetyProfilesMatch(review.textSafetyProfile, textSafetyProfile) ||
			!isApprovedVideoTextDecision(review.textDecision, textSafetyProfile) ||
			review.requestFingerprint !== object(job.inputSnapshot).requestFingerprint ||
			typeof review.validUntil !== "string" ||
			!Number.isFinite(Date.parse(review.validUntil)) ||
			new Date(review.validUntil) <= new Date()
		) {
			throw new Error("VIDEO_INPUT_REVIEW_REQUIRED");
		}
		const outputReservation = await tx.storageUsageReservation.findFirst({
			where: {
				ownerType: job.ownerType,
				ownerId: job.ownerId,
				referenceKey: videoOutputReservationKey(job.id),
				status: "ACTIVE",
				bytes: { gte: videoOutputReservationBytes(job.inputSnapshot) },
			},
		});
		if (!outputReservation) throw new Error("VIDEO_STORAGE_RESERVATION_REQUIRED");
		// A job can wait in moderation beyond a frozen price/authorization deadline.
		// Recheck under the submission lock using the database's current clock, but
		// never apply this to an existing may-have-sent attempt returned above.
		const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
			SELECT clock_timestamp() AS "now"`;
		if (!clock || !Number.isFinite(clock.now.getTime()))
			throw new Error("DATABASE_CLOCK_UNAVAILABLE");
		await findApprovedVideoTemplateMotionReference(
			object(job.inputSnapshot).videoEffectTemplate,
			tx,
			clock.now,
		);
		const pricingDetails = object(object(job.pricingSnapshot).pricingDetails);
		assertVideoPriceApprovalValid(pricingDetails, clock.now);
		if (
			pricingDetails.funding !== undefined &&
			(!readVideoInternalFundingSnapshot(pricingDetails.funding, job.ownerId, clock.now) ||
				pricingDetails.paidRevenueQualified !== false)
		)
			throw new Error("VIDEO_FUNDING_POLICY_CHANGED");
		const attempt = await tx.generationAttempt.create({
			data: {
				jobId: job.id,
				attemptNumber: 1,
				provider: "kie",
				providerModelId: input.providerModelId,
				callbackTokenHash: input.callbackTokenHash,
				requestSnapshot: effectiveSnapshot as Prisma.InputJsonValue,
				status: "SUBMISSION_UNCERTAIN",
				uncertainSubmission: true,
				submittedAt: new Date(),
			},
		});
		await tx.generationJob.update({
			where: { id: job.id },
			data: { status: "SUBMITTING", version: { increment: 1 } },
		});
		await tx.videoExecution.update({
			where: { jobId: job.id },
			data: {
				stage: "SUBMITTING",
				stateVersion: { increment: 1 },
				providerSubmitStartedAt: new Date(),
				lastProgressAt: new Date(),
			},
		});
		return { attempt, claimed: true };
	});
}

export async function recordVideoSubmissionAccepted(
	jobId: string,
	attemptId: string,
	taskId: string,
) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const job = await lockedContext(tx, jobId);
		const attempt = job.attempts.find((item) => item.id === attemptId);
		if (!attempt || (attempt.providerTaskId && attempt.providerTaskId !== taskId))
			throw new Error("VIDEO_PROVIDER_TASK_CONFLICT");
		if (terminal.has(job.videoExecution!.stage) || attempt.status === "SUCCEEDED") return;
		await tx.generationAttempt.update({
			where: { id: attemptId },
			data: {
				providerTaskId: taskId,
				status: "SUBMITTED",
				uncertainSubmission: false,
			},
		});
		if (job.videoExecution!.stage === "NEEDS_REVIEW") return;
		await tx.generationJob.update({
			where: { id: jobId },
			data: { status: "PROVIDER_PENDING", version: { increment: 1 } },
		});
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stage: "GENERATING",
				stateVersion: { increment: 1 },
				lastProgressAt: new Date(),
				providerAcceptedAt: job.videoExecution!.providerAcceptedAt ?? new Date(),
			},
		});
	});
}

export async function markVideoSubmissionUncertain(jobId: string, reasonCode: string) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const job = await lockedContext(tx, jobId);
		if (
			terminal.has(job.videoExecution!.stage) ||
			job.videoExecution!.stage === "NEEDS_REVIEW" ||
			job.attempts[0]?.providerTaskId
		)
			return;
		await tx.generationJob.update({
			where: { id: jobId },
			data: { status: "NEEDS_RECONCILIATION", version: { increment: 1 } },
		});
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stage: "SUBMISSION_UNCERTAIN",
				needsReviewReason: reasonCode,
				stateVersion: { increment: 1 },
				lastProgressAt: new Date(),
			},
		});
	});
}

export async function failVideoExecution(
	jobId: string,
	reasonCode: string,
	rejected = false,
	onlyBeforeAccepted = false,
	options: { onlyBeforeSubmission?: boolean } = {},
) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		await lockVideoOwnerStorage(tx, jobId);
		const job = await lockedContext(tx, jobId);
		if (
			terminal.has(job.videoExecution!.stage) ||
			job.videoExecution!.stage === "NEEDS_REVIEW" ||
			videoTemplateHasUnsettledScene(job.videoTemplateExecution) ||
			(options.onlyBeforeSubmission && job.attempts.length > 0) ||
			job.attempts[0]?.status === "SUCCEEDED" ||
			(onlyBeforeAccepted && job.attempts[0]?.providerTaskId) ||
			(!onlyBeforeAccepted &&
				(job.attempts.some((attempt) => attempt.uncertainSubmission) ||
					job.videoExecution!.stage === "SUBMISSION_UNCERTAIN"))
		)
			return false;
		await releaseVideoPreOutputCapacity(tx, job);
		if (job.reservation?.status === "ACTIVE")
			await releaseCreditsInTransaction(
				{
					reservationId: job.reservation.id,
					referenceKey: `video-v1:release:${jobId}`,
				},
				tx,
			);
		await tx.generationJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				failureCode: reasonCode,
				terminalAt: new Date(),
				version: { increment: 1 },
			},
		});
		await tx.generationAttempt.updateMany({
			where: { jobId, status: { notIn: ["SUCCEEDED", "FAILED"] } },
			data: {
				status: "FAILED",
				completedAt: new Date(),
				uncertainSubmission: false,
				errorSnapshot: { reasonCode },
			},
		});
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stage: rejected ? "REJECTED" : "FAILED",
				stateVersion: { increment: 1 },
				lastProgressAt: new Date(),
			},
		});
		await recordVideoTemplateBusinessEvent(tx, {
			jobId,
			event: "failed",
			templateSnapshot: job.videoTemplateExecution?.templateSnapshot,
		});
		return true;
	});
}

export async function recordVideoProviderSuccess(input: {
	jobId: string;
	attemptId: string;
	providerTaskId: string;
	outputUrl: string;
	providerCostMicros: bigint | null;
	providerCreditsConsumed?: number | null;
	providerCompletedAt: string | null;
}) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const job = await lockedContext(tx, input.jobId);
		const attempt = job.attempts.find((item) => item.id === input.attemptId);
		if (!attempt || attempt.providerTaskId !== input.providerTaskId)
			throw new Error("VIDEO_PROVIDER_TASK_CONFLICT");
		if (
			terminal.has(job.videoExecution!.stage) ||
			job.videoExecution!.stage === "NEEDS_REVIEW" ||
			attempt.status === "SUCCEEDED"
		)
			return;
		await tx.generationAttempt.update({
			where: { id: attempt.id },
			data: {
				status: "SUCCEEDED",
				uncertainSubmission: false,
				completedAt: new Date(),
				providerCostMicros: input.providerCostMicros,
				responseSnapshot: {
					authoritative: true,
					providerCompletedAt: input.providerCompletedAt,
					providerCreditsConsumed: input.providerCreditsConsumed ?? null,
				},
			},
		});
		await tx.generationAttemptTransferEnvelope.upsert({
			where: { attemptId: attempt.id },
			create: {
				attemptId: attempt.id,
				payload: { schemaVersion: 1, authority: "authenticated-query", outputUrl: input.outputUrl },
			},
			update: {
				payload: { schemaVersion: 1, authority: "authenticated-query", outputUrl: input.outputUrl },
			},
		});
		await tx.generationJob.update({
			where: { id: job.id },
			data: { status: "FINALIZING", version: { increment: 1 } },
		});
		await tx.videoExecution.update({
			where: { jobId: job.id },
			data: {
				stage: "STORING",
				stateVersion: { increment: 1 },
				lastProgressAt: new Date(),
				providerCompletedAt:
					input.providerCompletedAt && Number.isFinite(Date.parse(input.providerCompletedAt))
						? new Date(input.providerCompletedAt)
						: null,
				stageData: {
					...object(job.videoExecution!.stageData),
					timings: {
						...object(object(job.videoExecution!.stageData).timings),
						providerResultConfirmedAt: new Date().toISOString(),
					},
				} as Prisma.InputJsonValue,
			},
		});
	});
}

export async function recordVideoProviderAccounting(
	jobId: string,
	attemptId: string,
	providerCreditsConsumed: number | null,
) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const job = await lockedContext(tx, jobId);
		const attempt = job.attempts.find((item) => item.id === attemptId);
		if (!attempt) throw new Error("VIDEO_ATTEMPT_NOT_FOUND");
		await tx.generationAttempt.update({
			where: { id: attemptId },
			data: {
				responseSnapshot: {
					...object(attempt.responseSnapshot),
					authoritative: true,
					providerCreditsConsumed,
				} as Prisma.InputJsonValue,
			},
		});
	});
}

/** Inbox rows deliberately never create an Outbox event or run a legacy handler. */
export async function persistVideoProviderWebhook(input: {
	callbackTokenHash: string;
	taskId: string;
	timestamp: string;
	receivedAt: Date;
}) {
	const persisted = await runReadCommitted(getDatabaseClient(), async (tx) => {
		const found = await tx.generationAttempt.findUnique({
			where: { callbackTokenHash: input.callbackTokenHash },
		});
		if (!found || found.provider !== "kie") throw new Error("VIDEO_CALLBACK_ATTEMPT_INVALID");
		const job = await lockedContext(tx, found.jobId);
		const attempt = job.attempts.find((item) => item.id === found.id)!;
		if (attempt.providerTaskId && attempt.providerTaskId !== input.taskId)
			throw new Error("VIDEO_CALLBACK_TASK_INVALID");
		const providerEventId = `video-v1:${attempt.id}:${input.taskId}:${input.timestamp}`;
		const prior = await tx.providerWebhookEvent.findUnique({
			where: {
				provider_providerEventId: { provider: "kie-video-v1", providerEventId },
			},
		});
		// A valid early callback gives this already-fenced attempt its original task identity.
		if (!attempt.providerTaskId && !terminal.has(job.videoExecution!.stage)) {
			await tx.generationAttempt.update({
				where: { id: attempt.id },
				data: {
					providerTaskId: input.taskId,
					status: "SUBMITTED",
					uncertainSubmission: false,
				},
			});
			if (job.videoExecution!.stage !== "NEEDS_REVIEW") {
				await tx.generationJob.update({
					where: { id: job.id },
					data: { status: "PROVIDER_PENDING", version: { increment: 1 } },
				});
				await tx.videoExecution.update({
					where: { jobId: job.id },
					data: {
						stage: "GENERATING",
						providerAcceptedAt: job.videoExecution!.providerAcceptedAt ?? input.receivedAt,
						stateVersion: { increment: 1 },
						lastProgressAt: input.receivedAt,
					},
				});
			}
		}
		if (!prior)
			await tx.videoExecution.update({
				where: { jobId: job.id },
				data: {
					stageData: {
						...object(job.videoExecution!.stageData),
						timings: {
							...object(object(job.videoExecution!.stageData).timings),
							providerCallbackReceivedAt:
								object(object(job.videoExecution!.stageData).timings).providerCallbackReceivedAt ??
								input.receivedAt.toISOString(),
						},
					} as Prisma.InputJsonValue,
				},
			});
		const event =
			prior ??
			(await tx.providerWebhookEvent.create({
				data: {
					provider: "kie-video-v1",
					providerEventId,
					providerTaskId: input.taskId,
					verifiedAt: input.receivedAt,
					receivedAt: input.receivedAt,
					envelope: {
						executionEngine: ENGINE,
						jobId: job.id,
						attemptId: attempt.id,
						taskId: input.taskId,
						notifiedAt: null,
					},
				},
			}));
		return {
			eventId: event.id,
			jobId: job.id,
			workflowInstanceId: job.videoExecution!.workflowInstanceId,
			replayed: Boolean(prior),
			notified: typeof object(event.envelope).notifiedAt === "string",
			firstCallback:
				!prior && !object(object(job.videoExecution!.stageData).timings).providerCallbackReceivedAt,
		};
	});
	// Observe COMMIT without another database round trip before the wake. A lost
	// observation stays missing on replay, including a later callback timestamp.
	const { firstCallback, ...stored } = persisted;
	return { ...stored, ...(firstCallback ? { callbackPersistedAt: new Date().toISOString() } : {}) };
}

export async function markVideoWebhookNotified(eventId: string, callbackPersistedAt?: string) {
	const committedAt = callbackPersistedAt ?? null;
	const notifiedAt = new Date().toISOString();
	// Merge the optional timing into the existing notification write AFTER sendEvent.
	// Lock execution before inbox, as other video transitions do. Both JSON merges
	// use the current row, preserving concurrent confirmation/consumption fields.
	const marked = await getDatabaseClient().$queryRaw<Array<{ id: string }>>`
		WITH event_context AS (
			SELECT "id", "provider", "envelope" FROM "provider_webhook_event"
			WHERE "id" = ${eventId} AND "provider" IN ('kie-video-v1', 'kie-video-template-scene')
		), execution_lock AS MATERIALIZED (
			SELECT pg_advisory_xact_lock(hashtextextended('video-v1:' || (e."envelope"->>'jobId'), 0))
			FROM event_context e
			WHERE e."provider" = 'kie-video-v1' AND e."envelope"->>'executionEngine' = ${ENGINE}
				AND ${committedAt}::text IS NOT NULL
		), job_lock AS MATERIALIZED (
			SELECT j."id" FROM "generation_job" j JOIN event_context e ON j."id" = e."envelope"->>'jobId'
			WHERE j."executionEngine" = ${ENGINE} AND ${committedAt}::text IS NOT NULL
				AND (SELECT count(*) FROM execution_lock) > 0
			FOR UPDATE OF j
		), timing AS (
			UPDATE "video_execution" v
			SET "stageData" = jsonb_set(
				COALESCE(v."stageData", '{}'::jsonb), '{timings}',
				COALESCE(v."stageData"->'timings', '{}'::jsonb)
					|| jsonb_build_object('providerCallbackPersistedAt', ${committedAt}::text), true
			)
			FROM job_lock j
			WHERE v."jobId" = j."id"
				AND v."stageData" #>> '{timings,providerCallbackPersistedAt}' IS NULL
			RETURNING v."jobId"
		), notified AS (
			UPDATE "provider_webhook_event" e
			SET "envelope" = COALESCE(e."envelope", '{}'::jsonb)
				|| jsonb_build_object('notifiedAt', COALESCE(e."envelope"->>'notifiedAt', ${notifiedAt}::text))
			WHERE e."id" IN (SELECT "id" FROM event_context) AND (SELECT count(*) FROM timing) >= 0
			RETURNING e."id"
		)
		SELECT "id" FROM notified`;
	if (!marked.length) throw new Error("VIDEO_CALLBACK_EVENT_MISSING");
}

/** A failed delivery yields its place in the bounded recovery page. */
export async function postponeVideoWebhookNotification(eventId: string, now = new Date()) {
	await getDatabaseClient().providerWebhookEvent.updateMany({
		where: {
			id: eventId,
			provider: { in: ["kie-video-v1", "kie-video-template-scene"] },
			status: "RECEIVED",
		},
		data: { processingLeasedUntil: new Date(now.getTime() + 120_000) },
	});
}

export async function listPendingVideoWebhookEvents(limit: number, now = new Date()) {
	const database = getDatabaseClient();
	const batchLimit = Math.min(100, Math.max(1, Math.floor(limit)));
	// A callback can arrive after the final query's receivedThrough cutoff, even
	// after sendEvent succeeded. Retire that evidence only after the same attempt
	// has an authoritative result and the execution is terminal. Notification is
	// not consumption; NEEDS_REVIEW and uncertain attempts remain in the inbox.
	// This is part of the existing bounded recovery batch, never a legacy scan.
	await database.$executeRaw`
		WITH terminal_events AS (
			SELECT e."id"
			FROM "provider_webhook_event" e
			JOIN "generation_attempt" a ON a."id" = e."envelope"->>'attemptId'
				AND a."jobId" = e."envelope"->>'jobId'
			JOIN "generation_job" j ON j."id" = a."jobId" AND j."executionEngine" = ${ENGINE}
			JOIN "video_execution" v ON v."jobId" = j."id"
			WHERE e."provider" = 'kie-video-v1' AND e."status" = 'RECEIVED'
				AND e."verifiedAt" IS NOT NULL
				AND e."envelope"->>'executionEngine' = ${ENGINE}
				AND a."provider" = 'kie' AND a."providerTaskId" = e."providerTaskId"
				AND a."providerTaskId" = e."envelope"->>'taskId'
				AND v."stage" IN ('READY', 'FAILED', 'REJECTED')
				AND a."status" IN ('SUCCEEDED', 'FAILED') AND a."uncertainSubmission" = false
				AND a."responseSnapshot"->'authoritative' = 'true'::jsonb
			ORDER BY e."receivedAt", e."id" LIMIT ${batchLimit}
			FOR UPDATE OF e SKIP LOCKED
		)
		UPDATE "provider_webhook_event" e
		SET "status" = 'IGNORED', "processedAt" = ${now},
			"failureReason" = 'VIDEO_PROVIDER_RESULT_ALREADY_CONFIRMED', "processingLeasedUntil" = NULL
		FROM terminal_events t WHERE e."id" = t."id" AND e."status" = 'RECEIVED'`;
	// Select active notifications separately so retained unknown-state evidence
	// and any terminal backlog cannot starve a live workflow's bounded page.
	return database.$queryRaw<Array<{ eventId: string; jobId: string; workflowInstanceId: string }>>`
        WITH pending_events AS (
            SELECT e."id" AS "eventId", j."id" AS "jobId", v."workflowInstanceId",
                e."processingLeasedUntil", e."receivedAt"
            FROM "provider_webhook_event" e
            JOIN "generation_attempt" a ON a."id" = e."envelope"->>'attemptId'
                AND a."jobId" = e."envelope"->>'jobId'
            JOIN "generation_job" j ON j."id" = a."jobId" AND j."executionEngine" = ${ENGINE}
            JOIN "video_execution" v ON v."jobId" = j."id"
            WHERE e."provider" = 'kie-video-v1' AND e."status" = 'RECEIVED'
                AND e."verifiedAt" IS NOT NULL
                AND e."envelope"->>'executionEngine' = ${ENGINE}
                AND a."provider" = 'kie' AND a."providerTaskId" = e."providerTaskId"
                AND a."providerTaskId" = e."envelope"->>'taskId'
                AND v."stage" NOT IN ('READY', 'FAILED', 'REJECTED', 'NEEDS_REVIEW')
                AND e."envelope"->'notifiedAt' = 'null'::jsonb
                AND (e."processingLeasedUntil" IS NULL OR e."processingLeasedUntil" <= ${now})
            UNION ALL
            -- A scene has its own paid fence and task identity, never a GenerationAttempt.
            -- Validate that identity independently before joining the shared bounded page.
            SELECT e."id" AS "eventId", j."id" AS "jobId", v."workflowInstanceId",
                e."processingLeasedUntil", e."receivedAt"
            FROM "provider_webhook_event" e
            JOIN "video_template_execution" s ON s."jobId" = e."envelope"->>'jobId'
            JOIN "generation_job" j ON j."id" = s."jobId" AND j."executionEngine" = ${ENGINE}
            JOIN "video_execution" v ON v."jobId" = j."id"
            WHERE e."provider" = 'kie-video-template-scene' AND e."status" = 'RECEIVED'
                AND e."verifiedAt" IS NOT NULL
                AND s."submittedAt" IS NOT NULL AND s."sceneCallbackTokenHash" IS NOT NULL
                AND s."sceneProviderTaskId" = e."providerTaskId"
                AND s."sceneProviderTaskId" = e."envelope"->>'taskId'
                AND v."workflowInstanceId" = e."envelope"->>'workflowInstanceId'
                AND v."stage" NOT IN ('READY', 'FAILED', 'REJECTED', 'NEEDS_REVIEW')
                AND e."envelope"->'notifiedAt' = 'null'::jsonb
                AND (e."processingLeasedUntil" IS NULL OR e."processingLeasedUntil" <= ${now})
        )
        SELECT "eventId", "jobId", "workflowInstanceId" FROM pending_events
        ORDER BY "processingLeasedUntil" ASC NULLS FIRST, "receivedAt", "eventId" LIMIT ${batchLimit}`;
}

export async function consumeVideoProviderEvents(
	jobId: string,
	attemptId: string,
	receivedThrough: Date,
) {
	await getDatabaseClient().providerWebhookEvent.updateMany({
		where: {
			provider: "kie-video-v1",
			status: "RECEIVED",
			receivedAt: { lte: receivedThrough },
			AND: [
				{ envelope: { path: ["jobId"], equals: jobId } },
				{ envelope: { path: ["attemptId"], equals: attemptId } },
			],
		},
		data: { status: "PROCESSED", processedAt: new Date() },
	});
}
