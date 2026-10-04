import { createHash, randomUUID } from "node:crypto";

import { readVideoVisualSafetyProfile } from "@repo/config/video-safety";

import { getDatabaseClient } from "../../client";
import type { Prisma } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { runReadCommitted } from "./types";
import type { VideoModerationEventReference } from "./video-v1-moderation-events";

const ENGINE = "video-workflow-v1";
const PROVIDER = "seeapi-video-v1";
const MAX_CONFIRMATION_READS = 3;
const READ_LEASE_MS = 60_000;
const RETRYABLE_READ_REASONS = new Set([
	"MODERATION_TIMEOUT",
	"MODERATION_NETWORK_ERROR",
	"MODERATION_RATE_LIMITED",
	"MODERATION_SERVICE_ERROR",
]);
const object = (value: unknown): Prisma.InputJsonObject =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Prisma.InputJsonObject)
		: {};
const eventKey = (assetId: string, generation: number, attempt: number) =>
	`video-v1:${assetId}:${generation}:${attempt}`;

async function context(tx: Prisma.TransactionClient, jobId: string) {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`video-v1:${jobId}`}, 0))`;
	const bindings = await tx.generationJobAsset.findMany({
		where: { jobId, role: "OUTPUT" },
		select: { assetId: true },
		take: 2,
	});
	if (bindings.length !== 1) throw new Error("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
	await lockMediaAssetGenerationBindings([bindings[0]!.assetId], tx);
	const job = await tx.generationJob.findFirst({
		where: { id: jobId, executionEngine: ENGINE },
		include: {
			videoExecution: true,
			assets: { where: { role: "OUTPUT" }, include: { asset: true } },
		},
	});
	const asset = job?.assets[0]?.asset;
	const spec = object(object(job?.videoExecution?.stageData).outputSpec);
	const profile = readVideoVisualSafetyProfile(job?.inputSnapshot);
	if (
		!job?.videoExecution ||
		job.videoExecution.workflowInstanceId !== `video-v1-${job.id}` ||
		!asset ||
		profile.provider !== "seeapi" ||
		asset.verificationProvider !== "seeapi" ||
		asset.verificationEngine !== ENGINE ||
		asset.verificationRuleVersion !== profile.ruleVersion ||
		asset.verificationPolicyVersion !== profile.policyVersion ||
		asset.kind !== "OUTPUT" ||
		asset.ownerId !== job.ownerId ||
		asset.ownerType !== job.ownerType ||
		asset.deletedAt ||
		!asset.finalizedAt ||
		!asset.checksum ||
		!asset.storageEtag ||
		spec.assetId !== asset.id ||
		spec.checksum !== asset.checksum ||
		spec.etag !== asset.storageEtag ||
		!asset.verificationSubmittedAt ||
		!asset.verificationSubmissionToken ||
		asset.verificationGeneration < 1 ||
		asset.verificationAttemptCount < 1
	)
		throw new Error("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
	return { job, asset, profile };
}
type Context = Awaited<ReturnType<typeof context>>;
function matches(envelope: unknown, value: Context): boolean {
	const data = object(envelope);
	return (
		data.executionEngine === ENGINE &&
		data.jobId === value.job.id &&
		data.assetId === value.asset.id &&
		data.generation === value.asset.verificationGeneration &&
		data.attemptNumber === value.asset.verificationAttemptCount &&
		data.checksum === value.asset.checksum &&
		data.etag === value.asset.storageEtag &&
		data.visualSafetyContractVersion === value.profile.contractVersion
	);
}
function reference(
	event: { id: string; envelope: unknown; status: string },
	value: Context,
	replayed: boolean,
): VideoModerationEventReference {
	const notified =
		typeof object(event.envelope).notifiedAt === "string" || event.status !== "RECEIVED";
	return {
		eventId: event.id,
		replayed,
		notified,
		...(value.asset.verificationProviderTaskId &&
		value.job.videoExecution!.stage === "OUTPUT_REVIEW"
			? { jobId: value.job.id, workflowInstanceId: value.job.videoExecution!.workflowInstanceId }
			: {}),
	};
}

/** Caller first verifies official raw-body HMAC and the server URL proof. Never parse body task IDs. */
export async function persistSeeapiVideoModerationWebhook(input: {
	assetId: string;
	generation: number;
	attemptNumber: number;
	rawBody: string;
	eventHash: string;
	receivedAt: Date;
	deliveryMetadata?: Prisma.InputJsonObject;
}): Promise<VideoModerationEventReference> {
	if (
		!Number.isSafeInteger(input.generation) ||
		input.generation < 1 ||
		!Number.isSafeInteger(input.attemptNumber) ||
		input.attemptNumber < 1 ||
		Buffer.byteLength(input.rawBody, "utf8") > 256 * 1024 ||
		createHash("sha256").update(input.rawBody).digest("hex") !== input.eventHash
	)
		throw new Error("VIDEO_SEEAPI_CALLBACK_INPUT_INVALID");
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const bindings = await tx.generationJobAsset.findMany({
			where: { assetId: input.assetId, role: "OUTPUT", job: { executionEngine: ENGINE } },
			select: { jobId: true },
			take: 2,
		});
		if (bindings.length !== 1) throw new Error("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
		const value = await context(tx, bindings[0]!.jobId);
		if (
			value.asset.id !== input.assetId ||
			value.asset.verificationGeneration !== input.generation ||
			value.asset.verificationAttemptCount !== input.attemptNumber
		)
			throw new Error("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
		const providerEventId = eventKey(input.assetId, input.generation, input.attemptNumber);
		const prior = await tx.providerWebhookEvent.findUnique({
			where: { provider_providerEventId: { provider: PROVIDER, providerEventId } },
		});
		if (prior) {
			if (!matches(prior.envelope, value))
				throw new Error("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
			return reference(prior, value, true);
		}
		const event = await tx.providerWebhookEvent.create({
			data: {
				provider: PROVIDER,
				providerEventId,
				providerTaskId: value.asset.verificationProviderTaskId,
				verifiedAt: input.receivedAt,
				receivedAt: input.receivedAt,
				envelope: {
					executionEngine: ENGINE,
					jobId: value.job.id,
					workflowInstanceId: value.job.videoExecution!.workflowInstanceId,
					assetId: input.assetId,
					generation: input.generation,
					attemptNumber: input.attemptNumber,
					checksum: value.asset.checksum,
					etag: value.asset.storageEtag,
					visualSafetyContractVersion: value.profile.contractVersion,
					rawBody: input.rawBody,
					eventHash: input.eventHash,
					deliveryMetadata: input.deliveryMetadata ?? {},
					notifiedAt: null,
				},
			},
		});
		return reference(event, value, false);
	});
}

export async function listPendingSeeapiVideoModerationEvents(
	limit: number,
	jobId?: string,
): Promise<VideoModerationEventReference[]> {
	const db = getDatabaseClient();
	const events = await db.providerWebhookEvent.findMany({
		where: {
			provider: PROVIDER,
			status: "RECEIVED",
			...(jobId
				? { envelope: { path: ["jobId"], equals: jobId } }
				: {
						OR: [{ processingLeasedUntil: null }, { processingLeasedUntil: { lte: new Date() } }],
					}),
		},
		orderBy: { receivedAt: "asc" },
		take: Math.min(100, Math.max(1, limit)),
	});
	const references: VideoModerationEventReference[] = [];
	for (const event of events) {
		if (typeof object(event.envelope).notifiedAt === "string") continue;
		const boundJobId = object(event.envelope).jobId;
		if (typeof boundJobId !== "string") continue;
		const ref = await runReadCommitted(db, async (tx) => {
			const value = await context(tx, boundJobId);
			if (!matches(event.envelope, value))
				throw new Error("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
			if (value.job.videoExecution!.stage !== "OUTPUT_REVIEW") {
				await tx.providerWebhookEvent.updateMany({
					where: { id: event.id, status: "RECEIVED" },
					data: { status: "IGNORED", failureReason: "VIDEO_SEEAPI_CALLBACK_TERMINAL" },
				});
				return null;
			}
			if (!value.asset.verificationProviderTaskId) {
				await tx.providerWebhookEvent.update({
					where: { id: event.id },
					data: { processingLeasedUntil: new Date(Date.now() + 60_000) },
				});
				return null;
			}
			return reference(event, value, true);
		}).catch(async (error: unknown) => {
			// Deleted, replaced or terminal historical bindings cannot poison the
			// remaining inbox. Database/transport failures must still surface.
			if (
				!(error instanceof Error) ||
				!["VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID", "VIDEO_SAFETY_PROFILE_INVALID"].includes(
					error.message,
				)
			)
				throw error;
			await db.providerWebhookEvent.updateMany({
				where: { id: event.id, status: "RECEIVED" },
				data: { status: "IGNORED", failureReason: "VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID" },
			});
			return null;
		});
		if (ref) references.push(ref);
	}
	return references;
}

export async function markSeeapiVideoModerationWebhookNotified(eventId: string) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		await tx.$queryRaw`SELECT "id" FROM "provider_webhook_event" WHERE "id" = ${eventId} AND "provider" = ${PROVIDER} FOR UPDATE`;
		const event = await tx.providerWebhookEvent.findFirst({
			where: { id: eventId, provider: PROVIDER },
		});
		if (!event) throw new Error("VIDEO_SEEAPI_CALLBACK_MISSING");
		await tx.providerWebhookEvent.update({
			where: { id: event.id },
			data: {
				envelope: { ...object(event.envelope), notifiedAt: new Date().toISOString() },
				...(event.status === "RECEIVED" ? { processingLeasedUntil: null } : {}),
			},
		});
	});
}

/** One verified callback authorizes at most three reads, including abandoned claims after a crash. */
export async function claimSeeapiVideoConfirmation(jobId: string) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const value = await context(tx, jobId);
		const { asset, job } = value;
		const event = await tx.providerWebhookEvent.findUnique({
			where: {
				provider_providerEventId: {
					provider: PROVIDER,
					providerEventId: eventKey(
						asset.id,
						asset.verificationGeneration,
						asset.verificationAttemptCount,
					),
				},
			},
		});
		if (!event || !asset.verificationProviderTaskId) return { status: "WAITING" as const };
		if (!matches(event.envelope, value)) throw new Error("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
		const prior = object(object(job.videoExecution!.stageData).seeapiVisualReview);
		const now = new Date();
		const readAttemptCount = prior.eventId ? Number(prior.readAttemptCount ?? 1) : 0;
		if (
			!Number.isSafeInteger(readAttemptCount) ||
			readAttemptCount < 0 ||
			(prior.eventId && readAttemptCount < 1) ||
			readAttemptCount > MAX_CONFIRMATION_READS
		)
			throw new Error("VIDEO_SEEAPI_CONFIRMATION_STATE_INVALID");
		if (prior.eventId) {
			if (
				prior.eventId !== event.id ||
				prior.checksum !== asset.checksum ||
				prior.etag !== asset.storageEtag ||
				prior.providerTaskId !== asset.verificationProviderTaskId
			)
				throw new Error("VIDEO_SEEAPI_CONFIRMATION_IDENTITY_CHANGED");
			if (prior.phase === "COMPLETE")
				return { status: "CONSUMED" as const, eventId: event.id, decision: object(prior.decision) };
			if (prior.phase !== "CLAIMED" && prior.phase !== "WAIT_RETRY")
				throw new Error("VIDEO_SEEAPI_CONFIRMATION_STATE_INVALID");
			const nextRetryAt =
				typeof prior.nextRetryAt === "string"
					? new Date(prior.nextRetryAt)
					: event.processingLeasedUntil;
			if (!nextRetryAt || !Number.isFinite(nextRetryAt.getTime()))
				throw new Error("VIDEO_SEEAPI_CONFIRMATION_STATE_INVALID");
			if (nextRetryAt && nextRetryAt > now)
				return {
					status: "RETRY" as const,
					nextRetryAt: nextRetryAt.toISOString(),
					readAttemptCount,
				};
		}
		if (
			job.videoExecution!.stage !== "OUTPUT_REVIEW" ||
			!["RECEIVED", "PROCESSING"].includes(event.status)
		)
			return { status: "CONSUMED" as const, eventId: event.id };
		if (readAttemptCount >= MAX_CONFIRMATION_READS) {
			const decision = {
				decision: "ERROR",
				reasonCode: "VIDEO_SEEAPI_CONFIRMATION_UNCERTAIN",
				ruleVersion: value.profile.ruleVersion,
			};
			await tx.videoExecution.update({
				where: { jobId },
				data: {
					stageData: {
						...object(job.videoExecution!.stageData),
						seeapiVisualReview: {
							...prior,
							phase: "COMPLETE",
							decision,
							completedAt: now.toISOString(),
						},
					},
					stateVersion: { increment: 1 },
					lastProgressAt: now,
				},
			});
			await tx.providerWebhookEvent.update({
				where: { id: event.id },
				data: { status: "PROCESSED", processedAt: now, processingLeasedUntil: null },
			});
			return { status: "CONSUMED" as const, eventId: event.id, decision };
		}
		const token = randomUUID();
		const nextAttempt = readAttemptCount + 1;
		const leasedUntil = new Date(now.getTime() + READ_LEASE_MS);
		// An interrupted read consumes its budget. Only after its lease and short
		// backoff may another worker safely issue a read-only confirmation request.
		const nextRetryAt = new Date(
			leasedUntil.getTime() + (nextAttempt === 1 ? 1000 : nextAttempt === 2 ? 3000 : 0),
		).toISOString();
		await tx.providerWebhookEvent.update({
			where: { id: event.id },
			data: {
				status: "PROCESSING",
				processingToken: token,
				processingLeasedUntil: leasedUntil,
				providerTaskId: asset.verificationProviderTaskId,
			},
		});
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stageData: {
					...object(job.videoExecution!.stageData),
					seeapiVisualReview: {
						phase: "CLAIMED",
						eventId: event.id,
						token,
						checksum: asset.checksum,
						etag: asset.storageEtag,
						providerTaskId: asset.verificationProviderTaskId,
						claimedAt: now.toISOString(),
						readAttemptCount: nextAttempt,
						nextRetryAt,
					},
				},
				stateVersion: { increment: 1 },
				lastProgressAt: now,
			},
		});
		return {
			status: "CLAIMED" as const,
			eventId: event.id,
			token,
			providerTaskId: asset.verificationProviderTaskId,
			assetId: asset.id,
			readAttemptCount: nextAttempt,
			nextRetryAt,
		};
	});
}

/** Persist every GET result. Only recognized transient failures schedule a bounded read retry. */
export async function recordSeeapiVideoConfirmation(input: {
	jobId: string;
	eventId: string;
	token: string;
	decision: Prisma.InputJsonObject;
}) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const value = await context(tx, input.jobId);
		const { job, asset, profile } = value;
		const prior = object(object(job.videoExecution!.stageData).seeapiVisualReview);
		const event = await tx.providerWebhookEvent.findFirst({
			where: { id: input.eventId, provider: PROVIDER, processingToken: input.token },
		});
		if (
			!event ||
			!matches(event.envelope, value) ||
			prior.eventId !== event.id ||
			prior.token !== input.token ||
			prior.phase !== "CLAIMED" ||
			prior.providerTaskId !== asset.verificationProviderTaskId ||
			prior.checksum !== asset.checksum ||
			prior.etag !== asset.storageEtag ||
			input.decision.ruleVersion !== profile.ruleVersion ||
			typeof input.decision.decision !== "string" ||
			!["ALLOW", "REJECT", "REVIEW", "ERROR"].includes(input.decision.decision)
		)
			throw new Error("VIDEO_SEEAPI_CONFIRMATION_IDENTITY_CHANGED");
		const now = new Date();
		const readAttemptCount = Number(prior.readAttemptCount ?? 1);
		const retry =
			input.decision.decision === "ERROR" &&
			typeof input.decision.reasonCode === "string" &&
			RETRYABLE_READ_REASONS.has(input.decision.reasonCode) &&
			readAttemptCount < MAX_CONFIRMATION_READS;
		if (retry) {
			const nextRetryAt = new Date(
				now.getTime() + (readAttemptCount === 1 ? 1000 : 3000),
			).toISOString();
			await tx.videoExecution.update({
				where: { jobId: job.id },
				data: {
					stageData: {
						...object(job.videoExecution!.stageData),
						seeapiVisualReview: {
							...prior,
							phase: "WAIT_RETRY",
							lastDecision: input.decision,
							nextRetryAt,
						},
					},
					stateVersion: { increment: 1 },
					lastProgressAt: now,
				},
			});
			await tx.providerWebhookEvent.update({
				where: { id: event.id },
				data: { processingLeasedUntil: new Date(nextRetryAt) },
			});
			return { status: "RETRY" as const, nextRetryAt, readAttemptCount };
		}
		await tx.videoExecution.update({
			where: { jobId: job.id },
			data: {
				stageData: {
					...object(job.videoExecution!.stageData),
					seeapiVisualReview: {
						...prior,
						phase: "COMPLETE",
						decision: input.decision,
						completedAt: now.toISOString(),
					},
				},
				stateVersion: { increment: 1 },
				lastProgressAt: now,
			},
		});
		await tx.providerWebhookEvent.update({
			where: { id: event.id },
			data: { status: "PROCESSED", processedAt: now, processingLeasedUntil: null },
		});
		return { status: "COMPLETE" as const };
	});
}
