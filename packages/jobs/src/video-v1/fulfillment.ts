import type { MediaSafetyAdapter, ModerationDecision } from "@repo/ai/media/moderation/types";
import { createConfiguredVideoSafetyAdapter } from "@repo/ai/media/moderation/video-configured";
import { moderationServiceErrorCode } from "@repo/config";
import { maximumMediaStorageBytes } from "@repo/config/server";
import { videoOutputConstraints } from "@repo/config/video-output";
import { readVideoV1Config } from "@repo/config/video-v1";
import {
	beginVideoReviewSubmission,
	claimVideoOutputReview,
	claimVideoOutputStorage,
	completeVideoOutputStorage,
	failVideoDelivery,
	finalizeVideoDelivery,
	getVideoFulfillmentSnapshot,
	markVideoNeedsReview,
	recordVideoOutputReview,
	recordVideoReviewTask,
	releaseVideoReviewLease,
	releaseVideoStorageLease,
} from "@repo/database/video-v1-fulfillment";
import {
	claimSeeapiVideoConfirmation,
	recordSeeapiVideoConfirmation,
} from "@repo/database/video-v1-seeapi-events";
import { createSignedReadUrl } from "@repo/storage";

import type { ReviewStepResult, StoredOutputRef, VideoPublicState } from "./contracts";
import { inspectVideoObject, transferVideoOutput } from "./output-storage";
import { createSeeapiVideoCallbackUrl } from "./seeapi-callback-url";
import { notifyPendingSeeapiVideoModerationEvents } from "./seeapi-webhooks";
import { getVideoWorkflowBinding } from "./workflow-binding";

type Environment = Record<string, string | undefined>;
function confirmationRetry(nextRetryAt: string, deadlineAt?: Date | null): ReviewStepResult {
	return {
		status: "PENDING",
		waitFor: "confirmation-retry",
		nextRetryAt,
		retryAfterSeconds: Math.max(
			1,
			Math.ceil((new Date(nextRetryAt).getTime() - Date.now()) / 1000),
		),
		deadlineAt: deadlineAt?.toISOString(),
	};
}
/** No generation/provider submit dependency exists in this module. */
export async function storeVideoOutput(
	jobId: string,
	env: Environment = process.env,
): Promise<StoredOutputRef> {
	const config = readVideoV1Config(env);
	const claim = await claimVideoOutputStorage(jobId, maximumMediaStorageBytes(env));
	try {
		// A complete immutable object can outlive the DB commit. Read it by ETag and
		// recompute both checksum and MP4 spec before adopting it; never regenerate.
		const existing = await inspectVideoObject(
			claim.asset.objectKey,
			claim.status === "STORED" && claim.asset.checksum && claim.asset.storageEtag
				? {
						checksum: claim.asset.checksum,
						etag: claim.asset.storageEtag,
						bytes: Number(claim.asset.byteSize),
					}
				: undefined,
			claim.constraints,
		);
		if (claim.status === "STORED") {
			if (!existing) throw new Error("VIDEO_STORED_OBJECT_MISSING");
			return {
				assetId: claim.asset.id,
				checksum: existing.checksum,
				byteSize: String(existing.bytes),
			};
		}
		const stored =
			existing ??
			(await transferVideoOutput({
				key: claim.asset.objectKey,
				url: claim.sourceUrl,
				maxBytes: claim.maxBytes,
				constraints: claim.constraints,
				requestOptions: {
					allowedHosts: config.outputAllowedHosts,
					maxRedirects: 3,
					connectTimeoutMs: 10_000,
					firstByteTimeoutMs: 30_000,
					totalTimeoutMs: 120_000,
				},
			}));
		if (stored.bytes > claim.maxBytes)
			throw Object.assign(new Error("VIDEO_STORAGE_QUOTA_EXCEEDED"), {
				retryable: false,
				code: "VIDEO_STORAGE_QUOTA_EXCEEDED",
			});
		await completeVideoOutputStorage(jobId, claim.asset.id, claim.token, stored);
		return { assetId: claim.asset.id, checksum: stored.checksum, byteSize: String(stored.bytes) };
	} catch (error) {
		if (claim.token) await releaseVideoStorageLease(jobId, claim.asset.id, claim.token);
		const details = error as { retryable?: boolean; code?: string };
		if (details.retryable === false)
			await failVideoDelivery(jobId, details.code ?? "VIDEO_OUTPUT_SPECIFICATION_FAILED");
		throw error;
	}
}

/** Moderates the exact sealed private object. Partial frames never authorize delivery. */
export async function reviewStoredVideo(
	jobId: string,
	env: Environment = process.env,
	safety?: MediaSafetyAdapter,
): Promise<ReviewStepResult> {
	const config = readVideoV1Config(env);
	const claim = await claimVideoOutputReview(jobId, config.moderationDeadlineSeconds);
	if (claim.status === "APPROVED") return { status: "ALLOW" };
	if (claim.status === "REJECTED") return { status: "REJECT", reasonCode: claim.reasonCode };
	const { visualSafetyProfile, constraints, audioSafetyPolicy, durationMillis } =
		claim.reviewContext;
	const outputSpec = claim.reviewContext.outputSpec as {
		audioTracks?: number;
		audioTrackIds?: number[];
	};
	const video = { durationMillis, audioTrackIds: outputSpec.audioTrackIds ?? [] };
	const retiredReason =
		visualSafetyProfile.provider === "sightengine"
			? "MODERATION_PROVIDER_RETIRED"
			: outputSpec.audioTracks && audioSafetyPolicy.mode === "required"
				? "VIDEO_AUDIO_REVIEW_NOT_ENABLED"
				: null;
	if (retiredReason) {
		if (claim.token) await releaseVideoReviewLease(claim.asset.id, claim.token);
		await markVideoNeedsReview(jobId, retiredReason);
		return { status: "ERROR", reasonCode: retiredReason, retryable: false };
	}
	const adapter = safety ?? createConfiguredVideoSafetyAdapter(env, {}, visualSafetyProfile);
	if (claim.status === "BUSY")
		return visualSafetyProfile.provider === "seeapi"
			? claim.asset.verificationLeasedUntil
				? confirmationRetry(
						claim.asset.verificationLeasedUntil.toISOString(),
						claim.asset.verificationDeadlineAt,
					)
				: {
						status: "PENDING",
						waitFor: "callback",
						deadlineAt: claim.asset.verificationDeadlineAt?.toISOString(),
					}
			: { status: "PENDING", retryAfterSeconds: config.moderationPollSeconds };
	if (claim.status === "UNCERTAIN" || claim.status === "EXPIRED") {
		const reasonCode =
			claim.status === "UNCERTAIN"
				? "VIDEO_MODERATION_SUBMISSION_UNCERTAIN"
				: "VIDEO_MODERATION_DEADLINE";
		await markVideoNeedsReview(jobId, reasonCode);
		return { status: "ERROR", reasonCode, retryable: false };
	}
	const token = claim.token;
	if (!token || !claim.asset.checksum || !claim.asset.storageEtag)
		throw new Error("VIDEO_REVIEW_IDENTITY_REQUIRED");
	try {
		if (claim.status === "SUBMIT") {
			let callbackUrl: string | undefined;
			// Provider limits are checked before the durable may-have-sent fence.
			if (
				visualSafetyProfile.provider === "seeapi" &&
				(video.durationMillis < 1 ||
					video.durationMillis > 30_000 ||
					claim.asset.byteSize > 100_000_000n)
			) {
				await releaseVideoReviewLease(claim.asset.id, token);
				await markVideoNeedsReview(jobId, "VIDEO_SEEAPI_INPUT_LIMIT_EXCEEDED");
				return {
					status: "ERROR",
					reasonCode: "VIDEO_SEEAPI_INPUT_LIMIT_EXCEEDED",
					retryable: false,
				};
			}
			if (visualSafetyProfile.provider === "seeapi") {
				try {
					if (!env.SEEAPI_API_KEY?.trim()) throw new Error("VIDEO_SEEAPI_CALLBACK_NOT_CONFIGURED");
					callbackUrl = await createSeeapiVideoCallbackUrl(
						{
							assetId: claim.asset.id,
							generation: claim.asset.verificationGeneration,
							attemptNumber: claim.asset.verificationAttemptCount,
						},
						env,
					);
				} catch {
					await releaseVideoReviewLease(claim.asset.id, token);
					await markVideoNeedsReview(jobId, "VIDEO_SEEAPI_CALLBACK_NOT_CONFIGURED");
					return {
						status: "ERROR",
						reasonCode: "VIDEO_SEEAPI_CALLBACK_NOT_CONFIGURED",
						retryable: false,
					};
				}
			}
			const stored = await inspectVideoObject(
				claim.asset.objectKey,
				{
					checksum: claim.asset.checksum,
					etag: claim.asset.storageEtag,
					bytes: Number(claim.asset.byteSize),
				},
				constraints,
			);
			if (!stored) throw new Error("VIDEO_STORED_OBJECT_MISSING");
			const assetUrl = await createSignedReadUrl({
				bucket: "media",
				key: claim.asset.objectKey,
				expiresIn: Math.min(7200, config.moderationDeadlineSeconds + 300),
			});
			await beginVideoReviewSubmission(claim.asset.id, token);
			const submitted = await adapter.submitVideo({
				assetUrl,
				ruleVersion: visualSafetyProfile.ruleVersion,
				visualSafetyProfile,
				idempotencyKey: `video-v1:${claim.asset.id}:${claim.asset.checksum}`,
				video,
				...(callbackUrl ? { callbackUrl } : {}),
			});
			await recordVideoReviewTask(claim.asset.id, token, submitted.moderationTaskId);
			const binding = getVideoWorkflowBinding();
			if (binding) {
				await notifyPendingSeeapiVideoModerationEvents({ binding, jobId });
			}
			// Consume already-finished review now instead of imposing a fixed sleep.
			return reviewStoredVideo(jobId, env, adapter);
		}
		if (!claim.asset.verificationProviderTaskId) throw new Error("VIDEO_MODERATION_TASK_REQUIRED");
		let decision: ModerationDecision;
		if (visualSafetyProfile.provider === "seeapi") {
			const confirmation = await claimSeeapiVideoConfirmation(jobId);
			if (confirmation.status === "WAITING") {
				await releaseVideoReviewLease(claim.asset.id, token);
				return {
					status: "PENDING",
					waitFor: "callback",
					deadlineAt: claim.asset.verificationDeadlineAt?.toISOString(),
				};
			}
			if (confirmation.status === "RETRY") {
				await releaseVideoReviewLease(claim.asset.id, token);
				return confirmationRetry(confirmation.nextRetryAt, claim.asset.verificationDeadlineAt);
			}
			if (confirmation.status === "CONSUMED") {
				if (!confirmation.decision) {
					await releaseVideoReviewLease(claim.asset.id, token);
					await markVideoNeedsReview(jobId, "VIDEO_SEEAPI_CONFIRMATION_UNCERTAIN");
					return {
						status: "ERROR",
						reasonCode: "VIDEO_SEEAPI_CONFIRMATION_UNCERTAIN",
						retryable: false,
					};
				}
				decision = confirmation.decision as unknown as ModerationDecision;
			} else {
				try {
					decision = await adapter.retrieveVideo({
						moderationTaskId: confirmation.providerTaskId,
						ruleVersion: visualSafetyProfile.ruleVersion,
						visualSafetyProfile,
						video,
					});
				} catch (error) {
					decision = {
						decision: "ERROR",
						reasonCode: moderationServiceErrorCode(error),
						ruleVersion: visualSafetyProfile.ruleVersion,
					};
				}
				try {
					const recorded = await recordSeeapiVideoConfirmation({
						jobId,
						eventId: confirmation.eventId,
						token: confirmation.token,
						decision: JSON.parse(JSON.stringify(decision)),
					});
					if (recorded.status === "RETRY") {
						await releaseVideoReviewLease(claim.asset.id, token);
						return confirmationRetry(recorded.nextRetryAt, claim.asset.verificationDeadlineAt);
					}
				} catch {
					// The result commit can itself be ambiguous. Re-read its durable
					// state after the read lease; never reset the counter or re-POST.
					await releaseVideoReviewLease(claim.asset.id, token);
					return confirmationRetry(confirmation.nextRetryAt, claim.asset.verificationDeadlineAt);
				}
			}
			if (
				decision.decision === "ERROR" ||
				decision.decision === "REVIEW" ||
				(decision.decision === "ALLOW" && !decision.evidence?.video?.complete)
			) {
				const reasonCode =
					decision.reasonCode === "VIDEO_PROCESSING"
						? "VIDEO_SEEAPI_CONFIRMATION_NOT_TERMINAL"
						: decision.decision === "ALLOW"
							? "VIDEO_MODERATION_COMPLETION_MISSING"
							: decision.reasonCode;
				await releaseVideoReviewLease(claim.asset.id, token);
				await markVideoNeedsReview(jobId, reasonCode);
				return { status: "ERROR", reasonCode, retryable: false };
			}
		} else {
			decision = await adapter.retrieveVideo({
				moderationTaskId: claim.asset.verificationProviderTaskId,
				ruleVersion: visualSafetyProfile.ruleVersion,
				visualSafetyProfile,
				video,
			});
		}
		if (decision.decision === "REVIEW" && decision.reasonCode === "VIDEO_PROCESSING") {
			await releaseVideoReviewLease(claim.asset.id, token);
			return {
				status: "PENDING",
				retryAfterSeconds: config.moderationPollSeconds,
				deadlineAt: claim.asset.verificationDeadlineAt?.toISOString(),
			};
		}
		if (decision.decision === "ERROR") {
			await releaseVideoReviewLease(claim.asset.id, token);
			return { status: "ERROR", reasonCode: decision.reasonCode, retryable: true };
		}
		if (decision.decision === "REVIEW") {
			await releaseVideoReviewLease(claim.asset.id, token);
			await markVideoNeedsReview(jobId, decision.reasonCode);
			return { status: "ERROR", reasonCode: decision.reasonCode, retryable: false };
		}
		const complete = decision.evidence?.video?.complete === true;
		if (decision.decision === "ALLOW" && !complete) {
			await releaseVideoReviewLease(claim.asset.id, token);
			return {
				status: "ERROR",
				reasonCode: "VIDEO_MODERATION_COMPLETION_MISSING",
				retryable: true,
			};
		}
		const allowed = decision.decision === "ALLOW" && complete;
		await recordVideoOutputReview({
			jobId,
			assetId: claim.asset.id,
			token,
			checksum: claim.asset.checksum,
			etag: claim.asset.storageEtag,
			decision: allowed ? "ALLOW" : "REJECT",
			reasonCode: decision.reasonCode,
			complete,
			evidence: decision.evidence ? JSON.parse(JSON.stringify(decision.evidence)) : {},
		});
		if (!allowed) {
			await failVideoDelivery(jobId, decision.reasonCode, true);
			return { status: "REJECT", reasonCode: decision.reasonCode };
		}
		return { status: "ALLOW" };
	} catch (error) {
		await releaseVideoReviewLease(claim.asset.id, token);
		// An uncertain moderation request is persisted before sending. Recovery
		// cannot blindly create a second paid moderation request.
		throw error;
	}
}

export async function finalizeVideoJob(jobId: string): Promise<VideoPublicState> {
	const job = await getVideoFulfillmentSnapshot(jobId);
	const asset = job.assets[0]?.asset;
	if (!asset?.checksum || !asset.storageEtag) throw new Error("VIDEO_FINAL_OUTPUT_MISSING");
	const checked = await inspectVideoObject(
		asset.objectKey,
		{
			checksum: asset.checksum,
			etag: asset.storageEtag,
			bytes: Number(asset.byteSize),
		},
		videoOutputConstraints(job.inputSnapshot),
	);
	if (!checked) throw new Error("VIDEO_FINAL_OUTPUT_UNREADABLE");
	return finalizeVideoDelivery(jobId, {
		assetId: asset.id,
		checksum: checked.checksum,
		etag: checked.etag,
		checkedAt: new Date(),
	});
}

export async function failVideoJob(
	jobId: string,
	reasonCode: string,
	rejected = false,
): Promise<VideoPublicState> {
	return failVideoDelivery(jobId, reasonCode, rejected);
}
