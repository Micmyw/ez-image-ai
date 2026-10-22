import { createHash } from "node:crypto";

import { getDatabaseClient } from "../../client";
import type { Prisma } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { runReadCommitted } from "./types";
import { getVideoEffectiveInputSnapshot } from "./video-template-execution";
import { assertVideoInputIdentity, getVideoInputReviewContext } from "./video-v1-execution";
import type { VideoModerationEventReference } from "./video-v1-moderation-events";

const PROVIDER = "seeapi-video-input-v1";
const ENGINE = "video-workflow-v1";
const object = (value: unknown): Prisma.InputJsonObject =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Prisma.InputJsonObject)
		: {};

export interface SeeapiVideoInputCallbackIdentity {
	jobId: string;
	assetId: string;
	submissionToken: string;
}

async function context(tx: Prisma.TransactionClient, input: SeeapiVideoInputCallbackIdentity) {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`video-v1:${input.jobId}`}, 0))`;
	await lockMediaAssetGenerationBindings([input.assetId], tx);
	const job = await getVideoInputReviewContext(input.jobId, tx);
	if (!job?.videoExecution || job.videoExecution.workflowInstanceId !== `video-v1-${job.id}`)
		throw new Error("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
	assertVideoInputIdentity(job);
	const snapshot = getVideoEffectiveInputSnapshot(job);
	const identity = object(snapshot.inputIdentity);
	const review = object(object(job.videoExecution.stageData).inputReview);
	const callback = object(review.imageCallback);
	if (
		snapshot.mode !== "image-to-video" ||
		callback.token !== input.submissionToken ||
		callback.assetId !== input.assetId ||
		identity.assetId !== input.assetId ||
		callback.requestFingerprint !== snapshot.requestFingerprint ||
		review.requestFingerprint !== snapshot.requestFingerprint ||
		!["checksum", "objectKey", "storageEtag", "storageVersionId", "verificationGeneration"].every(
			(field) => callback[field] === identity[field],
		) ||
		(!review.imageSubmissionUncertain && typeof review.imageTaskId !== "string")
	)
		throw new Error("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
	return { job, callback, review };
}
type Context = Awaited<ReturnType<typeof context>>;

function reference(
	event: { id: string; status: string; envelope: unknown },
	value: Context,
	replayed: boolean,
): VideoModerationEventReference {
	// The signed callback only wakes the original Workflow. It never resolves an
	// uncertain send or supplies a task ID; the next step still uses persisted state.
	const active =
		value.job.videoExecution!.stage === "INPUT_REVIEW" &&
		!value.job.attempts.length &&
		value.review.status !== "ALLOW";
	return {
		eventId: event.id,
		replayed,
		notified:
			!active ||
			event.status !== "RECEIVED" ||
			typeof object(event.envelope).notifiedAt === "string",
		...(active
			? { jobId: value.job.id, workflowInstanceId: value.job.videoExecution!.workflowInstanceId }
			: {}),
	};
}

function matches(envelope: unknown, value: Context): boolean {
	const data = object(envelope);
	return (
		data.executionEngine === ENGINE &&
		data.jobId === value.job.id &&
		[
			"token",
			"assetId",
			"checksum",
			"objectKey",
			"storageEtag",
			"storageVersionId",
			"verificationGeneration",
			"requestFingerprint",
		].every((field) => object(data.callback)[field] === value.callback[field])
	);
}

/** Official signature and a purpose-bound URL must be verified before calling this. */
export async function persistSeeapiVideoInputModerationWebhook(
	input: SeeapiVideoInputCallbackIdentity & {
		rawBody: string;
		eventHash: string;
		receivedAt: Date;
		deliveryMetadata?: Prisma.InputJsonObject;
	},
): Promise<VideoModerationEventReference> {
	if (
		!/^[A-Za-z0-9_-]{1,160}$/.test(input.jobId) ||
		!/^[A-Za-z0-9_-]{1,160}$/.test(input.assetId) ||
		!/^[A-Za-z0-9_-]{16,128}$/.test(input.submissionToken) ||
		Buffer.byteLength(input.rawBody, "utf8") > 256 * 1024 ||
		createHash("sha256").update(input.rawBody).digest("hex") !== input.eventHash
	)
		throw new Error("VIDEO_SEEAPI_CALLBACK_INPUT_INVALID");
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const value = await context(tx, input);
		const providerEventId = `video-input-v1:${input.jobId}:${input.submissionToken}`;
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
				providerTaskId:
					typeof value.review.imageTaskId === "string" ? value.review.imageTaskId : null,
				verifiedAt: input.receivedAt,
				receivedAt: input.receivedAt,
				envelope: {
					executionEngine: ENGINE,
					jobId: value.job.id,
					workflowInstanceId: value.job.videoExecution!.workflowInstanceId,
					callback: value.callback,
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

/** Recovery is always scoped to a video-owned candidate, never a global inbox scan. */
export async function listPendingSeeapiVideoInputModerationEvents(
	limit: number,
	jobId: string,
): Promise<VideoModerationEventReference[]> {
	const db = getDatabaseClient();
	const events = await db.providerWebhookEvent.findMany({
		where: { provider: PROVIDER, status: "RECEIVED", envelope: { path: ["jobId"], equals: jobId } },
		orderBy: { receivedAt: "asc" },
		take: Math.min(100, Math.max(1, limit)),
	});
	const result: VideoModerationEventReference[] = [];
	for (const event of events) {
		if (typeof object(event.envelope).notifiedAt === "string") continue;
		const callback = object(object(event.envelope).callback);
		if (typeof callback.assetId !== "string" || typeof callback.token !== "string") continue;
		const ref = await runReadCommitted(db, async (tx) => {
			const value = await context(tx, {
				jobId,
				assetId: callback.assetId as string,
				submissionToken: callback.token as string,
			});
			if (!matches(event.envelope, value))
				throw new Error("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
			const ref = reference(event, value, true);
			if (ref.notified) {
				await tx.providerWebhookEvent.updateMany({
					where: { id: event.id, status: "RECEIVED" },
					data: { status: "IGNORED", failureReason: "VIDEO_SEEAPI_CALLBACK_TERMINAL" },
				});
				return null;
			}
			return ref;
		}).catch(async (error: unknown) => {
			if (
				!(error instanceof Error) ||
				![
					"VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID",
					"VIDEO_INPUT_IDENTITY_CHANGED",
					"VIDEO_TEMPLATE_SCENE_REVIEW_EXPIRED",
					"VIDEO_TEMPLATE_REFERENCE_INPUT_REVIEW_REQUIRED",
				].includes(error.message)
			)
				throw error;
			await db.providerWebhookEvent.updateMany({
				where: { id: event.id, status: "RECEIVED" },
				data: { status: "IGNORED", failureReason: "VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID" },
			});
			return null;
		});
		if (ref) result.push(ref);
	}
	return result;
}

export async function markSeeapiVideoInputModerationWebhookNotified(eventId: string) {
	return getDatabaseClient().providerWebhookEvent.updateMany({
		where: { id: eventId, provider: PROVIDER, status: "RECEIVED" },
		data: { status: "PROCESSED", processedAt: new Date() },
	});
}
