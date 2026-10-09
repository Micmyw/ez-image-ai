import { randomUUID } from "node:crypto";

import {
	VIDEO_AUDIO_POLICY_VERSION,
	VIDEO_OUTPUT_MAX_BYTES,
	readVideoAudioSafetyPolicy,
	videoOutputConstraints,
	videoOutputSpecificationFailure,
	createVideoOutputReport,
	videoResolutionPixelContract,
	type VideoOutputMetadata,
} from "@repo/config/video-output";
import {
	createVideoVisualSafetyProfile,
	readVideoVisualSafetyProfile,
	type VideoVisualSafetyProfile,
} from "@repo/config/video-safety";

import { getDatabaseClient } from "../../client";
import type { Prisma } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { releaseCreditsInTransaction, settleCreditsInTransaction } from "./credits";
import { runReadCommitted } from "./types";
import { recordVideoTemplateBusinessEvent } from "./video-template-events";
import { videoTemplateHasUnsettledScene } from "./video-template-storage";
import {
	lockVideoOwnerStorage,
	releaseVideoPreOutputCapacity,
	videoOutputReservationBytes,
	videoOutputReservationKey,
	videoOwnerStorageUsage,
} from "./video-v1-storage";
export {
	claimVideoAudioStep,
	recordVideoAudioTranscript,
	recordVideoAudioDecision,
} from "./video-v1-audio-review";

const ENGINE = "video-workflow-v1";
const MAX_BYTES = VIDEO_OUTPUT_MAX_BYTES;
const include = {
	videoExecution: true,
	videoTemplateExecution: true,
	reservation: true,
	attempts: { orderBy: { attemptNumber: "desc" }, take: 1, include: { transferEnvelope: true } },
	assets: {
		where: { role: "OUTPUT" },
		include: {
			asset: {
				include: {
					moderationResults: {
						orderBy: [{ verificationGeneration: "desc" }, { attemptNumber: "desc" }],
						take: 1,
					},
				},
			},
		},
	},
} satisfies Prisma.GenerationJobInclude;
type VideoJob = Prisma.GenerationJobGetPayload<{ include: typeof include }>;
type VideoAsset = VideoJob["assets"][number]["asset"];
function json(value: unknown): Prisma.InputJsonObject {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Prisma.InputJsonObject)
		: {};
}
async function lock(tx: Prisma.TransactionClient, jobId: string) {
	// Read after acquiring this per-job lock. Serializable predicate locks on
	// asset/ledger scans cause unrelated video jobs to abort under concurrency.
	// READ COMMITTED is safe here because state transitions share this lock,
	// assets share the deletion/binding lock, and the ledger locks account/lots.
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`video-v1:${jobId}`}, 0))`;
	await tx.$queryRaw`SELECT "id" FROM "generation_job" WHERE "id" = ${jobId} AND "executionEngine" = ${ENGINE} FOR UPDATE`;
	const bindings = await tx.generationJobAsset.findMany({
		where: { jobId, role: "OUTPUT" },
		select: { assetId: true },
	});
	await lockMediaAssetGenerationBindings(
		bindings.map((binding) => binding.assetId),
		tx,
	);
	await tx.$queryRaw`SELECT asset."id" FROM "media_asset" asset JOIN "generation_job_asset" binding ON binding."assetId" = asset."id" WHERE binding."jobId" = ${jobId} AND binding."role" = 'OUTPUT'::"GenerationJobAssetRole" FOR UPDATE OF asset`;
}
function assertVideo(
	job: VideoJob | null,
): asserts job is VideoJob & { videoExecution: NonNullable<VideoJob["videoExecution"]> } {
	if (!job || job.executionEngine !== ENGINE || !job.videoExecution || job.ownerType !== "USER")
		throw new Error("VIDEO_JOB_NOT_FOUND");
}
export async function getVideoFulfillmentSnapshot(jobId: string) {
	const job = await getDatabaseClient().generationJob.findUnique({ where: { id: jobId }, include });
	assertVideo(job);
	return job;
}
function state(job: VideoJob) {
	assertVideo(job);
	return {
		jobId: job.id,
		stage: job.videoExecution.stage,
		creditState:
			job.reservation?.status === "SETTLED"
				? ("SETTLED" as const)
				: job.reservation?.status === "RELEASED"
					? ("RELEASED" as const)
					: ("RESERVED" as const),
		credits: job.creditsReserved.toString(),
		canPlay:
			job.videoExecution.stage === "READY" &&
			job.status === "SUCCEEDED" &&
			job.reservation?.status === "SETTLED",
		failureCode: job.failureCode,
		updatedAt: job.updatedAt.toISOString(),
	};
}

export async function claimVideoOutputStorage(jobId: string, maximumStorageBytes: bigint) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const owner = await lockVideoOwnerStorage(tx, jobId);
		await lock(tx, jobId);
		const job = await tx.generationJob.findUnique({ where: { id: jobId }, include });
		assertVideo(job);
		const attempt = job.attempts[0];
		const constraints = videoOutputConstraints(job.inputSnapshot);
		const payload = json(attempt?.transferEnvelope?.payload);
		if (
			!attempt ||
			attempt.status !== "SUCCEEDED" ||
			payload.authority !== "authenticated-query" ||
			typeof payload.outputUrl !== "string"
		)
			throw new Error("VIDEO_AUTHORITY_RESULT_REQUIRED");
		if (["FAILED", "REJECTED", "NEEDS_REVIEW"].includes(job.videoExecution.stage))
			throw new Error("VIDEO_JOB_TERMINAL");
		let asset = job.assets[0]?.asset;
		if (
			asset &&
			(asset.ownerId !== job.ownerId ||
				asset.ownerType !== job.ownerType ||
				asset.verificationEngine !== ENGINE ||
				asset.deletedAt)
		)
			throw new Error("VIDEO_OUTPUT_OWNER_MISMATCH");
		if (asset?.checksum && asset.finalizedAt)
			return {
				status: "STORED" as const,
				constraints,
				asset,
				maxBytes: Number(asset.byteSize),
				sourceUrl: payload.outputUrl,
				token: null,
			};
		const now = new Date();
		if (asset?.outputTransferLeaseExpiresAt && asset.outputTransferLeaseExpiresAt > now)
			throw new Error("VIDEO_STORAGE_BUSY");
		const assetId = asset?.id ?? randomUUID();
		const referenceKey = `generation-output:${assetId}`;
		const prepaidKey = videoOutputReservationKey(job.id);
		const reservations = await tx.storageUsageReservation.findMany({
			where: { referenceKey: { in: [referenceKey, prepaidKey] } },
		});
		if (
			reservations.some((row) => row.ownerId !== owner.ownerId || row.ownerType !== owner.ownerType)
		)
			throw new Error("VIDEO_STORAGE_RESERVATION_OWNER_MISMATCH");
		if (reservations.length > 1) throw new Error("VIDEO_STORAGE_RESERVATION_CONFLICT");
		const reservation = reservations[0];
		const requiredBytes = videoOutputReservationBytes(job.inputSnapshot);
		// Admission capacity survives elapsed leases and plan/quota changes. Older
		// already-paid jobs may adopt capacity only here, after authenticated success.
		if (!reservation || reservation.status !== "ACTIVE" || reservation.bytes < requiredBytes) {
			const usedBytes = await videoOwnerStorageUsage(tx, owner, [referenceKey, prepaidKey]);
			if (usedBytes + requiredBytes > maximumStorageBytes)
				throw new Error("VIDEO_STORAGE_QUOTA_EXCEEDED");
		}
		const maxBytes = Number(requiredBytes);
		const token = randomUUID();
		const expiresAt = new Date(now.getTime() + 5 * 60_000);
		if (!asset) {
			asset = await tx.mediaAsset.create({
				data: {
					id: assetId,
					...owner,
					kind: "OUTPUT",
					status: "VERIFYING",
					verificationEngine: ENGINE,
					objectKey: `users/${job.ownerId}/video-v1/${job.id}/${assetId}.mp4`,
					mimeType: "video/mp4",
					byteSize: 0n,
				},
				include: { moderationResults: true },
			});
			await tx.generationJobAsset.create({
				data: { jobId, assetId, role: "OUTPUT", assetChecksum: "pending", position: 0 },
			});
		}
		if (reservation)
			await tx.storageUsageReservation.update({
				where: { id: reservation.id },
				data: { referenceKey, bytes: requiredBytes, status: "ACTIVE", expiresAt, releasedAt: null },
			});
		else
			await tx.storageUsageReservation.create({
				data: { ...owner, referenceKey, bytes: requiredBytes, expiresAt },
			});
		asset = await tx.mediaAsset.update({
			where: { id: assetId },
			data: { outputTransferToken: token, outputTransferLeaseExpiresAt: expiresAt },
			include: { moderationResults: true },
		});
		await tx.videoExecution.update({
			where: { jobId, stateVersion: job.videoExecution.stateVersion },
			data: {
				stage: "STORING",
				storageStartedAt: job.videoExecution.storageStartedAt ?? now,
				lastProgressAt: now,
				stateVersion: { increment: 1 },
			},
		});
		await tx.generationJob.update({
			where: { id: jobId },
			data: { status: "FINALIZING", version: { increment: 1 } },
		});
		return {
			status: "CLAIMED" as const,
			asset,
			token,
			sourceUrl: payload.outputUrl,
			maxBytes,
			constraints,
		};
	});
}

export type VerifiedVideoObject = VideoOutputMetadata & {
	bytes: number;
	checksum: string;
	etag: string;
};
export async function completeVideoOutputStorage(
	jobId: string,
	assetId: string,
	token: string,
	output: VerifiedVideoObject,
) {
	if (
		!/^[a-f0-9]{64}$/.test(output.checksum) ||
		output.bytes < 1 ||
		output.bytes > MAX_BYTES ||
		output.videoTracks !== 1
	)
		throw new Error("VIDEO_STORED_SPECIFICATION_INVALID");
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const owner = await lockVideoOwnerStorage(tx, jobId);
		await lock(tx, jobId);
		const job = await tx.generationJob.findUnique({ where: { id: jobId }, include });
		assertVideo(job);
		const specificationFailure = videoOutputSpecificationFailure(
			output,
			videoOutputConstraints(job.inputSnapshot),
		);
		if (specificationFailure) throw new Error(specificationFailure);
		if (
			readVideoAudioSafetyPolicy(job.inputSnapshot).mode === "required" &&
			output.audioTracks > 0 &&
			output.bytes > 25_000_000
		)
			throw new Error("VIDEO_AUDIO_MEDIA_TOO_LARGE");
		const asset = job.assets.find((entry) => entry.assetId === assetId)?.asset;
		if (!asset || asset.ownerId !== job.ownerId || asset.verificationEngine !== ENGINE)
			throw new Error("VIDEO_OUTPUT_OWNER_MISMATCH");
		if (asset.finalizedAt && asset.checksum === output.checksum) return asset;
		if (
			asset.outputTransferToken !== token ||
			!asset.outputTransferLeaseExpiresAt ||
			asset.outputTransferLeaseExpiresAt < new Date() ||
			job.videoExecution.stage !== "STORING"
		)
			throw new Error("VIDEO_STORAGE_LEASE_STALE");
		const reserved = await tx.storageUsageReservation.updateMany({
			where: {
				...owner,
				referenceKey: `generation-output:${assetId}`,
				status: "ACTIVE",
				bytes: { gte: BigInt(output.bytes) },
			},
			data: { status: "COMMITTED", bytes: BigInt(output.bytes) },
		});
		if (reserved.count !== 1) throw new Error("VIDEO_STORAGE_RESERVATION_MISSING");
		const now = new Date();
		const result = await tx.mediaAsset.update({
			where: { id: assetId },
			data: {
				byteSize: BigInt(output.bytes),
				checksum: output.checksum,
				storageEtag: output.etag,
				width: output.width,
				height: output.height,
				durationMillis: BigInt(output.durationMillis),
				finalizedAt: now,
				outputTransferToken: null,
				outputTransferLeaseExpiresAt: null,
			},
		});
		await tx.generationJobAsset.updateMany({
			where: { jobId, assetId, role: "OUTPUT" },
			data: { assetChecksum: output.checksum },
		});
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stage: "OUTPUT_REVIEW",
				storageCompletedAt: now,
				lastProgressAt: now,
				stateVersion: { increment: 1 },
				stageData: {
					...json(job.videoExecution.stageData),
					outputSpec: {
						report: createVideoOutputReport(output, videoOutputConstraints(job.inputSnapshot)),
						assetId,
						checksum: output.checksum,
						etag: output.etag,
						audioTracks: output.audioTracks,
						audioTrackIds: output.audioTrackIds ?? [],
						width: output.width,
						height: output.height,
						requestedResolution: videoOutputConstraints(job.inputSnapshot).resolution,
						pixelContract: videoResolutionPixelContract(videoOutputConstraints(job.inputSnapshot)),
						requiresDurationEvidence: typeof json(job.inputSnapshot).productKey === "string",
						durationMillis: output.durationMillis,
					},
				},
			},
		});
		return result;
	});
}

export async function releaseVideoStorageLease(jobId: string, assetId: string, token: string) {
	await getDatabaseClient().mediaAsset.updateMany({
		where: {
			id: assetId,
			verificationEngine: ENGINE,
			outputTransferToken: token,
			jobBindings: { some: { jobId } },
		},
		data: { outputTransferLeaseExpiresAt: new Date(0) },
	});
}

export async function claimVideoOutputReview(jobId: string, deadlineSeconds: number) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		await lock(tx, jobId);
		const job = await tx.generationJob.findUnique({ where: { id: jobId }, include });
		assertVideo(job);
		const profile = readVideoVisualSafetyProfile(job.inputSnapshot);
		const asset = job.assets[0]?.asset;
		if (
			!asset?.checksum ||
			!asset.storageEtag ||
			!asset.finalizedAt ||
			asset.kind !== "OUTPUT" ||
			asset.ownerType !== job.ownerType ||
			asset.ownerId !== job.ownerId ||
			asset.verificationEngine !== ENGINE
		)
			throw new Error("VIDEO_STORED_OUTPUT_REQUIRED");
		if (
			(asset.verificationProvider !== null ||
				asset.verificationRuleVersion !== null ||
				asset.verificationPolicyVersion !== null) &&
			!matchingVisualIdentity(asset, profile)
		)
			throw new Error("VIDEO_VISUAL_PROFILE_IDENTITY_CHANGED");
		// This round's context comes from the same locked graph as the asset and
		// lease checks. Keep asset/status/token on the claim; later steps revalidate.
		const constraints = videoOutputConstraints(job.inputSnapshot);
		const audioSafetyPolicy = readVideoAudioSafetyPolicy(job.inputSnapshot);
		const outputSpec = json(json(job.videoExecution.stageData).outputSpec);
		const reviewContext = {
			visualSafetyProfile: profile,
			audioSafetyPolicy,
			constraints,
			durationMillis: Number(asset.durationMillis ?? constraints.durationSeconds * 1000),
			outputSpec,
		};
		if (
			hasVideoApproval(
				asset,
				new Date(),
				json(json(job.videoExecution.stageData).outputSpec),
				profile,
				readVideoAudioSafetyPolicy(job.inputSnapshot),
			)
		)
			return { status: "APPROVED" as const, asset, token: null, reviewContext };
		if (job.videoExecution.stage === "REJECTED")
			return {
				status: "REJECTED" as const,
				asset,
				token: null,
				reasonCode: job.failureCode ?? "VIDEO_OUTPUT_REJECTED",
				reviewContext,
			};
		if (["FAILED", "REJECTED", "READY", "NEEDS_REVIEW"].includes(job.videoExecution.stage))
			throw new Error("VIDEO_REVIEW_TERMINAL");
		const now = new Date();
		if (asset.verificationLeasedUntil && asset.verificationLeasedUntil > now)
			return { status: "BUSY" as const, asset, token: null, reviewContext };
		if (asset.verificationSubmissionUncertain && !asset.verificationProviderTaskId)
			return { status: "UNCERTAIN" as const, asset, token: null, reviewContext };
		if (asset.verificationDeadlineAt && asset.verificationDeadlineAt <= now)
			return { status: "EXPIRED" as const, asset, token: null, reviewContext };
		const token = randomUUID();
		const result = await tx.mediaAsset.update({
			where: { id: asset.id },
			data: {
				verificationLeaseToken: token,
				// Initial preflight streams the stored video before it may send a
				// moderation request; allow the same five-minute budget as its step.
				verificationLeasedUntil: new Date(
					now.getTime() +
						(asset.verificationProviderTaskId &&
						json(json(job.videoExecution.stageData).outputSpec).audioTracks !== 1
							? 60_000
							: 300_000),
				),
				verificationProvider: profile.provider,
				verificationRuleVersion: profile.ruleVersion,
				verificationPolicyVersion: profile.policyVersion,
				verificationGeneration: Math.max(1, asset.verificationGeneration),
				verificationAttemptCount: Math.max(1, asset.verificationAttemptCount),
				verificationDeadlineAt:
					asset.verificationDeadlineAt ?? new Date(now.getTime() + deadlineSeconds * 1000),
			},
			include: { moderationResults: true },
		});
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stage: "OUTPUT_REVIEW",
				outputReviewStartedAt: job.videoExecution.outputReviewStartedAt ?? now,
				lastProgressAt: now,
				stateVersion: { increment: 1 },
			},
		});
		return {
			status: asset.verificationProviderTaskId ? ("QUERY" as const) : ("SUBMIT" as const),
			asset: result,
			token,
			reviewContext,
		};
	});
}

/** Local inspection/signing is retryable; only this fence permits the paid POST. */
export async function beginVideoReviewSubmission(assetId: string, token: string) {
	const now = new Date();
	const claimed = await getDatabaseClient().mediaAsset.updateMany({
		where: {
			id: assetId,
			verificationEngine: ENGINE,
			verificationLeaseToken: token,
			verificationLeasedUntil: { gt: now },
			verificationProviderTaskId: null,
			verificationSubmissionUncertain: false,
			deletedAt: null,
			jobBindings: {
				some: {
					role: "OUTPUT",
					job: { executionEngine: ENGINE, videoExecution: { stage: "OUTPUT_REVIEW" } },
				},
			},
		},
		data: {
			verificationSubmissionUncertain: true,
			verificationSubmittedAt: now,
			verificationSubmissionToken: token,
		},
	});
	if (claimed.count !== 1) throw new Error("VIDEO_REVIEW_SUBMISSION_FENCE_UNAVAILABLE");
}

export async function recordVideoReviewTask(assetId: string, token: string, taskId: string) {
	const result = await getDatabaseClient().mediaAsset.updateMany({
		where: { id: assetId, verificationEngine: ENGINE, verificationLeaseToken: token },
		data: {
			verificationProviderTaskId: taskId,
			verificationSubmissionUncertain: false,
			verificationLeaseToken: null,
			verificationLeasedUntil: null,
		},
	});
	if (result.count !== 1) throw new Error("VIDEO_REVIEW_LEASE_STALE");
}
export async function releaseVideoReviewLease(assetId: string, token: string) {
	await getDatabaseClient().mediaAsset.updateMany({
		where: { id: assetId, verificationEngine: ENGINE, verificationLeaseToken: token },
		data: { verificationLeaseToken: null, verificationLeasedUntil: null },
	});
}
export async function markVideoNeedsReview(jobId: string, reasonCode: string) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		await lock(tx, jobId);
		const job = await tx.generationJob.findUnique({ where: { id: jobId }, include });
		assertVideo(job);
		if (["READY", "FAILED", "REJECTED"].includes(job.videoExecution.stage)) return;
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stage: "NEEDS_REVIEW",
				needsReviewReason: reasonCode,
				lastProgressAt: new Date(),
				stateVersion: { increment: 1 },
			},
		});
		await recordVideoTemplateBusinessEvent(tx, {
			jobId,
			event: "held",
			templateSnapshot: job.videoTemplateExecution?.templateSnapshot,
		});
		await tx.generationJob.update({
			where: { id: jobId },
			data: { status: "NEEDS_RECONCILIATION", failureCode: reasonCode, version: { increment: 1 } },
		});
	});
}

export async function recordVideoOutputReview(input: {
	jobId: string;
	assetId: string;
	token: string;
	checksum: string;
	etag: string;
	decision: "ALLOW" | "REJECT" | "ERROR";
	reasonCode: string;
	complete: boolean;
	evidence: Prisma.InputJsonObject;
}) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		await lock(tx, input.jobId);
		const job = await tx.generationJob.findUnique({ where: { id: input.jobId }, include });
		assertVideo(job);
		const asset = job.assets.find((entry) => entry.assetId === input.assetId)?.asset;
		const profile = readVideoVisualSafetyProfile(job.inputSnapshot);
		if (
			!asset ||
			asset.verificationLeaseToken !== input.token ||
			asset.checksum !== input.checksum ||
			asset.storageEtag !== input.etag ||
			!matchingVisualIdentity(asset, profile) ||
			job.videoExecution.stage !== "OUTPUT_REVIEW"
		)
			throw new Error("VIDEO_REVIEW_IDENTITY_CHANGED");
		if (input.decision === "ALLOW" && !input.complete)
			throw new Error("VIDEO_FULL_MODERATION_REQUIRED");
		const spec = json(json(job.videoExecution.stageData).outputSpec);
		const audioSafetyPolicy = readVideoAudioSafetyPolicy(job.inputSnapshot);
		if (input.decision === "ALLOW" && !matchingVisualApproval(asset, profile, input.evidence))
			throw new Error("VIDEO_VISUAL_PROFILE_EVIDENCE_REQUIRED");
		const visualConfirmation = json(json(job.videoExecution.stageData).seeapiVisualReview);
		if (
			input.decision === "ALLOW" &&
			profile.provider === "seeapi" &&
			(visualConfirmation.phase !== "COMPLETE" ||
				json(visualConfirmation.decision).decision !== "ALLOW" ||
				visualConfirmation.providerTaskId !== asset.verificationProviderTaskId ||
				visualConfirmation.checksum !== asset.checksum ||
				visualConfirmation.etag !== asset.storageEtag ||
				typeof visualConfirmation.eventId !== "string")
		)
			throw new Error("VIDEO_SEEAPI_CALLBACK_CONFIRMATION_REQUIRED");
		if (
			input.decision === "ALLOW" &&
			spec.requiresDurationEvidence === true &&
			json(input.evidence.video).durationMillis !== Number(asset.durationMillis)
		)
			throw new Error("VIDEO_FULL_DURATION_MODERATION_REQUIRED");
		if (
			input.decision === "ALLOW" &&
			audioSafetyPolicy.mode === "required" &&
			!matchingAudioApproval(asset, spec, input.evidence)
		)
			throw new Error("VIDEO_AUDIO_MODERATION_REQUIRED");
		if (
			input.decision === "ALLOW" &&
			audioSafetyPolicy.mode === "required" &&
			spec.audioTracks === 1
		) {
			const audioReview = json(json(job.videoExecution.stageData).audioReview);
			if (
				audioReview.phase !== "COMPLETE" ||
				json(audioReview.decision).decision !== "ALLOW" ||
				audioReview.checksum !== asset.checksum ||
				audioReview.etag !== asset.storageEtag
			)
				throw new Error("VIDEO_AUDIO_MODERATION_REQUIRED");
		}
		const now = new Date();
		// Immutable video approval covers its advertised 30-day retention. A
		// short 24h expiry would permanently strand a settled READY video: the
		// legacy re-review workers intentionally do not own these assets.
		const validUntil =
			input.decision === "ALLOW" ? new Date(now.getTime() + 30 * 24 * 60 * 60_000) : null;
		await tx.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: input.checksum,
				verificationGeneration: asset.verificationGeneration,
				attemptNumber: asset.verificationAttemptCount,
				evidenceKind: "OUTPUT",
				provider: profile.provider,
				providerTaskId: asset.verificationProviderTaskId,
				ruleVersion: profile.ruleVersion,
				policyVersion: profile.policyVersion,
				status:
					input.decision === "ALLOW"
						? "APPROVED"
						: input.decision === "REJECT"
							? "REJECTED"
							: "ERROR",
				reasonCode: input.reasonCode,
				categories: [],
				rawEnvelope: {
					...input.evidence,
					complete: input.complete,
					objectEtag: input.etag,
					visualSafetyProfile: profile,
					audioSafetyPolicy,
					...(profile.provider === "seeapi"
						? { seeapiConfirmationEventId: visualConfirmation.eventId }
						: {}),
				},
				validUntil,
			},
		});
		await tx.mediaAsset.update({
			where: { id: asset.id },
			data: {
				verificationValidUntil: validUntil,
				verificationLeaseToken: null,
				verificationLeasedUntil: null,
				verificationSubmissionUncertain: false,
				...(validUntil ? { deleteAfter: validUntil } : {}),
				...(input.decision === "REJECT" ? { status: "QUARANTINED" } : {}),
			},
		});
		if (input.decision === "ALLOW")
			await tx.videoExecution.update({
				where: { jobId: job.id },
				data: {
					stage: "FINALIZING",
					outputReviewCompletedAt: now,
					finalizationStartedAt: now,
					lastProgressAt: now,
					stateVersion: { increment: 1 },
				},
			});
		if (input.decision === "REJECT") {
			// Persist refusal and release in this same transaction. A crash after
			// recording unique evidence must not strand an ACTIVE reservation.
			if (!job.reservation || job.reservation.status !== "ACTIVE")
				throw new Error("VIDEO_RESERVATION_NOT_ACTIVE");
			await releaseCreditsInTransaction(
				{ reservationId: job.reservation.id, referenceKey: `video-v1:${job.id}:release` },
				tx,
			);
			await tx.videoExecution.update({
				where: { jobId: job.id },
				data: {
					stage: "REJECTED",
					outputReviewCompletedAt: now,
					needsReviewReason: null,
					lastProgressAt: now,
					stateVersion: { increment: 1 },
				},
			});
			await tx.generationJob.update({
				where: { id: job.id },
				data: {
					status: "FAILED",
					failureCode: input.reasonCode,
					terminalAt: now,
					version: { increment: 1 },
				},
			});
		}
	});
}

function matchingVisualIdentity(asset: VideoAsset, profile: VideoVisualSafetyProfile): boolean {
	return (
		asset.verificationProvider === profile.provider &&
		asset.verificationRuleVersion === profile.ruleVersion &&
		asset.verificationPolicyVersion === profile.policyVersion
	);
}

/** Authenticated sampled-frame results retain their provider-specific scope. */
function matchingVisualApproval(
	asset: VideoAsset,
	profile: VideoVisualSafetyProfile,
	evidence: Prisma.InputJsonObject,
): boolean {
	if (profile.provider === "sightengine") return true; // Historical evidence keeps its original contract.
	const video = json(evidence.video);
	const report = json(evidence.seeapiVideo);
	const sampling = json(profile.sampling);
	const durationMillis = Number(asset.durationMillis);
	return Boolean(
		asset.byteSize <= 100_000_000n &&
		durationMillis > 0 &&
		durationMillis <= 30_000 &&
		evidence.requestId === asset.verificationProviderTaskId &&
		Array.isArray(evidence.models) &&
		evidence.models.includes("video-nsfw-filter") &&
		video.complete === true &&
		video.durationMillis === durationMillis &&
		video.frameCount === sampling.numFrames &&
		typeof video.firstFrameSeconds === "number" &&
		Number.isFinite(video.firstFrameSeconds) &&
		video.firstFrameSeconds >= 0 &&
		video.firstFrameSeconds * 1000 <= Number(sampling.maxFirstFrameMillis) &&
		typeof video.lastFrameSeconds === "number" &&
		Number.isFinite(video.lastFrameSeconds) &&
		video.lastFrameSeconds * 1000 >= durationMillis - Number(sampling.maxLastFrameGapMillis) &&
		video.lastFrameSeconds * 1000 <= durationMillis + Number(sampling.maxEndOverrunMillis) &&
		report.taskId === asset.verificationProviderTaskId &&
		report.model === "video-nsfw-filter" &&
		report.scope === "sampled_frames" &&
		report.samplingComplete === true &&
		report.requestedFrames === sampling.numFrames &&
		report.checkedFrames === sampling.numFrames &&
		report.timestampSource === "frame_index_div_fps_estimate" &&
		report.reportSchemaVersion === 5 &&
		report.thresholdOffset === sampling.thresholdOffset &&
		report.strictSpecialCare === sampling.strictSpecialCare &&
		report.returnFrames === sampling.returnFrames &&
		report.flagged === false &&
		report.flaggedFrameCount === 0 &&
		Array.isArray(report.nsfw) &&
		report.nsfw.length === 0 &&
		(report.specialCare === undefined ||
			(Array.isArray(report.specialCare) && report.specialCare.length === 0)) &&
		typeof report.specialCareReportedFrames === "number" &&
		Number.isInteger(report.specialCareReportedFrames) &&
		report.specialCareReportedFrames >= 0 &&
		report.specialCareReportedFrames <= Number(sampling.numFrames) &&
		typeof report.maxFrameGapSeconds === "number" &&
		Number.isFinite(report.maxFrameGapSeconds) &&
		report.maxFrameGapSeconds >= 0 &&
		report.maxFrameGapSeconds * 1000 <= Number(sampling.maxFrameGapMillis),
	);
}

function matchingAudioApproval(
	asset: VideoAsset,
	spec: Prisma.InputJsonObject,
	evidence: Prisma.InputJsonObject,
): boolean {
	if (spec.audioTracks === 0) return true;
	const audio = json(evidence.audio);
	return Boolean(
		spec.audioTracks === 1 &&
		Array.isArray(spec.audioTrackIds) &&
		spec.audioTrackIds.length === 1 &&
		audio.complete === true &&
		audio.transcriptModerated === true &&
		audio.policyVersion === VIDEO_AUDIO_POLICY_VERSION &&
		typeof audio.language === "string" &&
		audio.language.length > 0 &&
		audio.durationMillis === Number(asset.durationMillis) &&
		Array.isArray(audio.trackIds) &&
		audio.trackIds.length === 1 &&
		audio.trackIds[0] === spec.audioTrackIds[0],
	);
}

export function hasVideoApproval(
	asset: VideoAsset,
	now = new Date(),
	spec?: Prisma.InputJsonObject,
	profile: VideoVisualSafetyProfile = createVideoVisualSafetyProfile("sightengine", 5),
	audioSafetyPolicy: ReturnType<typeof readVideoAudioSafetyPolicy> = {
		schemaVersion: 1,
		mode: "required",
	},
): boolean {
	const evidence = asset.moderationResults[0];
	const raw = json(evidence?.rawEnvelope);
	if (
		asset.mimeType !== "video/mp4" ||
		asset.byteSize <= 0n ||
		asset.byteSize > BigInt(MAX_BYTES) ||
		!asset.durationMillis ||
		asset.durationMillis <= 0n ||
		asset.durationMillis > 30250n ||
		(spec !== undefined &&
			audioSafetyPolicy.mode === "required" &&
			!matchingAudioApproval(asset, spec, raw)) ||
		(audioSafetyPolicy.mode === "not_requested" &&
			(json(raw.audioSafetyPolicy).schemaVersion !== 1 ||
				json(raw.audioSafetyPolicy).mode !== "not_requested")) ||
		!matchingVisualApproval(asset, profile, raw) ||
		(profile.provider === "seeapi" && typeof raw.seeapiConfirmationEventId !== "string") ||
		(spec?.requiresDurationEvidence === true &&
			json(raw.video).durationMillis !== Number(asset.durationMillis)) ||
		evidence?.evidenceKind !== "OUTPUT" ||
		evidence.validUntil?.getTime() !== asset.verificationValidUntil?.getTime()
	)
		return false;
	return Boolean(
		asset.verificationEngine === ENGINE &&
		asset.deletedAt === null &&
		(!asset.deleteAfter || asset.deleteAfter > now) &&
		asset.checksum &&
		asset.storageEtag &&
		asset.verificationValidUntil &&
		asset.verificationValidUntil > now &&
		matchingVisualIdentity(asset, profile) &&
		evidence?.status === "APPROVED" &&
		evidence.assetChecksum === asset.checksum &&
		evidence.provider === asset.verificationProvider &&
		evidence.providerTaskId === asset.verificationProviderTaskId &&
		evidence.verificationGeneration === asset.verificationGeneration &&
		evidence.attemptNumber === asset.verificationAttemptCount &&
		evidence.ruleVersion === profile.ruleVersion &&
		evidence.policyVersion === profile.policyVersion &&
		evidence.validUntil &&
		evidence.validUntil > now &&
		raw.complete === true &&
		raw.objectEtag === asset.storageEtag,
	);
}

export async function finalizeVideoDelivery(
	jobId: string,
	attestation: { assetId: string; checksum: string; etag: string; checkedAt: Date },
) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		await lock(tx, jobId);
		const job = await tx.generationJob.findUnique({ where: { id: jobId }, include });
		assertVideo(job);
		if (["READY", "FAILED", "REJECTED"].includes(job.videoExecution.stage)) return state(job);
		const asset = job.assets[0]?.asset;
		const spec = json(json(job.videoExecution.stageData).outputSpec);
		const now = new Date();
		if (
			!asset ||
			!hasVideoApproval(
				asset,
				now,
				spec,
				readVideoVisualSafetyProfile(job.inputSnapshot),
				readVideoAudioSafetyPolicy(job.inputSnapshot),
			) ||
			asset.status !== "VERIFYING" ||
			asset.ownerId !== job.ownerId ||
			asset.ownerType !== job.ownerType ||
			asset.id !== attestation.assetId ||
			asset.checksum !== attestation.checksum ||
			asset.storageEtag !== attestation.etag ||
			now.getTime() - attestation.checkedAt.getTime() > 30_000 ||
			attestation.checkedAt > now ||
			job.videoExecution.stage !== "FINALIZING" ||
			job.status !== "FINALIZING" ||
			videoOutputSpecificationFailure(
				{
					durationMillis: Number(asset.durationMillis),
					width: asset.width ?? 0,
					height: asset.height ?? 0,
					audioTracks: Number(spec.audioTracks),
					audioTrackIds: Array.isArray(spec.audioTrackIds) ? spec.audioTrackIds.map(Number) : [],
					videoTracks: 1,
				},
				videoOutputConstraints(job.inputSnapshot),
			) !== null ||
			spec.checksum !== asset.checksum ||
			spec.etag !== asset.storageEtag ||
			!job.reservation ||
			job.reservation.status !== "ACTIVE"
		)
			throw new Error("VIDEO_DELIVERY_PRECONDITION_FAILED");
		await settleCreditsInTransaction(
			{
				reservationId: job.reservation.id,
				amount: job.creditsReserved,
				referenceKey: `video-v1:${job.id}:settle`,
			},
			tx,
		);
		await tx.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
		await tx.videoExecution.update({
			where: { jobId },
			data: { stage: "READY", readyAt: now, lastProgressAt: now, stateVersion: { increment: 1 } },
		});
		const result = await tx.generationJob.update({
			where: { id: jobId },
			data: { status: "SUCCEEDED", terminalAt: now, failureCode: null, version: { increment: 1 } },
			include,
		});
		await recordVideoTemplateBusinessEvent(tx, {
			jobId,
			event: "ready",
			templateSnapshot: job.videoTemplateExecution?.templateSnapshot,
		});
		return state(result);
	});
}

export async function failVideoDelivery(jobId: string, reasonCode: string, rejected = false) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		await lockVideoOwnerStorage(tx, jobId);
		await lock(tx, jobId);
		const job = await tx.generationJob.findUnique({ where: { id: jobId }, include });
		assertVideo(job);
		if (["READY", "FAILED", "REJECTED"].includes(job.videoExecution.stage)) return state(job);
		if (
			videoTemplateHasUnsettledScene(job.videoTemplateExecution) ||
			job.attempts.some((attempt) => attempt.uncertainSubmission) ||
			job.videoExecution.stage === "SUBMISSION_UNCERTAIN"
		)
			throw new Error("VIDEO_UNCERTAIN_RESERVATION_MUST_REMAIN");
		if (!job.reservation || job.reservation.status !== "ACTIVE")
			throw new Error("VIDEO_RESERVATION_NOT_ACTIVE");
		await releaseVideoPreOutputCapacity(tx, job);
		await releaseCreditsInTransaction(
			{ reservationId: job.reservation.id, referenceKey: `video-v1:${job.id}:release` },
			tx,
		);
		const now = new Date();
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stage: rejected ? "REJECTED" : "FAILED",
				needsReviewReason: null,
				lastProgressAt: now,
				stateVersion: { increment: 1 },
			},
		});
		const result = await tx.generationJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				failureCode: reasonCode,
				terminalAt: now,
				version: { increment: 1 },
			},
			include,
		});
		await tx.mediaAsset.updateMany({
			where: { jobBindings: { some: { jobId, role: "OUTPUT" } }, verificationEngine: ENGINE },
			data: { status: rejected ? "QUARANTINED" : "VERIFICATION_FAILED" },
		});
		await recordVideoTemplateBusinessEvent(tx, {
			jobId,
			event: "failed",
			templateSnapshot: job.videoTemplateExecution?.templateSnapshot,
		});
		return state(result);
	});
}

/** Null means unavailable; never reveal another owner's task or asset. */
export async function authorizeVideoPlayback(userId: string, jobId: string) {
	const job = await getDatabaseClient().generationJob.findFirst({
		where: {
			id: jobId,
			ownerType: "USER",
			ownerId: userId,
			executionEngine: ENGINE,
			status: "SUCCEEDED",
		},
		include,
	});
	if (!job || job.videoExecution?.stage !== "READY" || job.reservation?.status !== "SETTLED")
		return null;
	const asset = job.assets[0]?.asset;
	if (
		!asset ||
		asset.status !== "READY" ||
		asset.kind !== "OUTPUT" ||
		asset.ownerType !== job.ownerType ||
		asset.ownerId !== userId ||
		!hasVideoApproval(
			asset,
			new Date(),
			json(json(job.videoExecution.stageData).outputSpec),
			readVideoVisualSafetyProfile(job.inputSnapshot),
			readVideoAudioSafetyPolicy(job.inputSnapshot),
		)
	)
		return null;
	return asset;
}
