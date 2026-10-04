import { randomUUID } from "node:crypto";

import { getDatabaseClient } from "../../client";
import type { Prisma } from "../../generated/client";
import { runReadCommitted } from "./types";

const ENGINE = "video-workflow-v1";
const object = (value: unknown): Prisma.InputJsonObject =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Prisma.InputJsonObject)
		: {};
async function context(tx: Prisma.TransactionClient, jobId: string) {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`video-v1:${jobId}`}, 0))`;
	const job = await tx.generationJob.findFirst({
		where: { id: jobId, executionEngine: ENGINE },
		include: {
			videoExecution: true,
			assets: { where: { role: "OUTPUT" }, include: { asset: true } },
		},
	});
	const asset = job?.assets[0]?.asset;
	const spec = object(object(job?.videoExecution?.stageData).outputSpec);
	if (
		!job?.videoExecution ||
		!asset?.checksum ||
		!asset.storageEtag ||
		asset.deletedAt ||
		asset.verificationEngine !== ENGINE ||
		asset.ownerId !== job.ownerId ||
		asset.ownerType !== job.ownerType ||
		spec.checksum !== asset.checksum ||
		spec.etag !== asset.storageEtag ||
		spec.audioTracks !== 1 ||
		!Array.isArray(spec.audioTrackIds) ||
		spec.audioTrackIds.length !== 1 ||
		!Number.isInteger(spec.audioTrackIds[0])
	)
		throw new Error("VIDEO_AUDIO_IDENTITY_REQUIRED");
	const review = object(object(job.videoExecution.stageData).audioReview);
	if (review.checksum && (review.checksum !== asset.checksum || review.etag !== asset.storageEtag))
		throw new Error("VIDEO_AUDIO_IDENTITY_CHANGED");
	const audioTrackId = Number((spec.audioTrackIds as number[])[0]);
	return { job, asset, spec, review, audioTrackId };
}

/** Fences ASR and transcript policy separately so retries never repeat the paid ASR. */
export async function claimVideoAudioStep(jobId: string, phase: "transcribe" | "moderate") {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const { job, asset, audioTrackId, review } = await context(tx, jobId);
		if (review.phase === "COMPLETE") return { status: "COMPLETE" as const, review };
		if (job.videoExecution!.stage !== "OUTPUT_REVIEW")
			throw new Error("VIDEO_AUDIO_REVIEW_TERMINAL");
		if (phase === "transcribe" && review.phase === "TRANSCRIBED")
			return { status: "TRANSCRIBED" as const, review };
		if (review.phase === "TRANSCRIBING" || review.phase === "MODERATING")
			return {
				status:
					typeof review.leasedUntil === "string" && new Date(review.leasedUntil) > new Date()
						? ("BUSY" as const)
						: ("UNCERTAIN" as const),
				review,
			};
		if (phase === "moderate" && review.phase !== "TRANSCRIBED")
			throw new Error("VIDEO_AUDIO_TRANSCRIPT_REQUIRED");
		const token = randomUUID();
		const next = {
			...review,
			checksum: asset.checksum,
			etag: asset.storageEtag,
			audioTrackId,
			durationMillis: Number(asset.durationMillis),
			phase: phase === "transcribe" ? "TRANSCRIBING" : "MODERATING",
			token,
			leasedUntil: new Date(Date.now() + 300_000).toISOString(),
		};
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stageData: { ...object(job.videoExecution!.stageData), audioReview: next },
				stateVersion: { increment: 1 },
				lastProgressAt: new Date(),
			},
		});
		return { status: "CLAIMED" as const, token, review: next };
	});
}

export async function recordVideoAudioTranscript(
	jobId: string,
	token: string,
	transcript: Prisma.InputJsonObject,
) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const { job, asset, audioTrackId, review } = await context(tx, jobId);
		if (
			review.token !== token ||
			review.phase !== "TRANSCRIBING" ||
			job.videoExecution!.stage !== "OUTPUT_REVIEW" ||
			transcript.checksum !== asset.checksum ||
			transcript.audioTrackId !== audioTrackId ||
			transcript.durationMillis !== Number(asset.durationMillis) ||
			typeof transcript.text !== "string" ||
			transcript.text.length > 100_000
		)
			throw new Error("VIDEO_AUDIO_TRANSCRIPT_IDENTITY_CHANGED");
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stageData: {
					...object(job.videoExecution!.stageData),
					audioReview: {
						...review,
						phase: "TRANSCRIBED",
						token: null,
						leasedUntil: null,
						transcript,
					},
				},
				stateVersion: { increment: 1 },
				lastProgressAt: new Date(),
			},
		});
	});
}

export async function recordVideoAudioDecision(
	jobId: string,
	token: string,
	decision: Prisma.InputJsonObject,
) {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const { job, review } = await context(tx, jobId);
		if (
			review.token !== token ||
			review.phase !== "MODERATING" ||
			job.videoExecution!.stage !== "OUTPUT_REVIEW" ||
			typeof decision.decision !== "string" ||
			!["ALLOW", "REJECT", "REVIEW", "ERROR"].includes(decision.decision)
		)
			throw new Error("VIDEO_AUDIO_DECISION_IDENTITY_CHANGED");
		// Raw recognized speech is no longer required after policy evaluation.
		await tx.videoExecution.update({
			where: { jobId },
			data: {
				stageData: {
					...object(job.videoExecution!.stageData),
					audioReview: {
						...review,
						phase: "COMPLETE",
						token: null,
						leasedUntil: null,
						transcript: null,
						decision,
					},
				},
				stateVersion: { increment: 1 },
				lastProgressAt: new Date(),
			},
		});
	});
}
