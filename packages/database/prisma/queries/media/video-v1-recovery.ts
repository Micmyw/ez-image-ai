import { db } from "../../client";

const ENGINE = "video-workflow-v1";
const TERMINAL = ["READY", "REJECTED", "FAILED", "NEEDS_REVIEW"] as const;
export type VideoWaitPhase = "input" | "provider" | "output";

/** Called inside one durable step. Neither the client nor a DB lease survives a wait. */
export async function getVideoWorkflowCheckpoint(jobId: string, now = new Date()) {
	return db.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`video-v1:${jobId}`}, 0))`;
		await tx.$queryRaw`SELECT "jobId" FROM "video_execution" WHERE "jobId" = ${jobId} FOR UPDATE`;
		const execution = await tx.videoExecution.findFirst({
			where: { jobId, job: { executionEngine: ENGINE } },
		});
		if (
			!execution ||
			execution.workflowSchemaVersion !== 1 ||
			execution.workflowInstanceId !== `video-v1-${jobId}`
		) {
			throw new Error("VIDEO_EXECUTION_IDENTITY_MISMATCH");
		}
		const stageData =
			execution.stageData &&
			typeof execution.stageData === "object" &&
			!Array.isArray(execution.stageData)
				? execution.stageData
				: {};
		const timings =
			stageData.timings &&
			typeof stageData.timings === "object" &&
			!Array.isArray(stageData.timings)
				? stageData.timings
				: {};
		await tx.videoExecution.updateMany({
			where: { jobId, stateVersion: execution.stateVersion },
			data: {
				startState: "STARTED",
				nextStartAt: null,
				stageData: {
					...stageData,
					timings: {
						...timings,
						workflowStartedAt: timings.workflowStartedAt ?? now.toISOString(),
					},
				},
				stateVersion: { increment: 1 },
			},
		});
		return {
			jobId,
			stage: execution.stage,
			terminal: TERMINAL.includes(execution.stage as (typeof TERMINAL)[number]),
		};
	});
}

/** Durable database deadline and monotonically increasing query round. */
export async function getVideoWaitWindow(input: {
	jobId: string;
	phase: VideoWaitPhase;
	deadlineSeconds: number;
	round?: number;
	now?: Date;
}) {
	const now = input.now ?? new Date();
	const deadlineField =
		input.phase === "provider"
			? "providerDeadlineAt"
			: input.phase === "input"
				? "inputReviewDeadlineAt"
				: "outputReviewDeadlineAt";
	const roundField =
		input.phase === "provider"
			? "providerPollRound"
			: input.phase === "input"
				? "inputReviewRound"
				: "outputReviewRound";
	return db.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`video-v1:${input.jobId}`}, 0))`;
		await tx.$queryRaw`SELECT "jobId" FROM "video_execution" WHERE "jobId" = ${input.jobId} FOR UPDATE`;
		const execution = await tx.videoExecution.findFirst({
			where: {
				jobId: input.jobId,
				job: { executionEngine: ENGINE },
			},
		});
		if (!execution) throw new Error("VIDEO_EXECUTION_NOT_FOUND");
		const deadline =
			execution[deadlineField] ?? new Date(now.getTime() + input.deadlineSeconds * 1000);
		const round = Math.max(execution[roundField], input.round ?? 0);
		await tx.videoExecution.updateMany({
			where: { jobId: input.jobId, stateVersion: execution.stateVersion },
			data: { [deadlineField]: deadline, [roundField]: round, stateVersion: { increment: 1 } },
		});
		return {
			deadlineAt: deadline.toISOString(),
			round,
			remainingSeconds: Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / 1000)),
		};
	});
}

/** Uncertainty/configuration outages preserve the reservation and original attempt. */
export async function markVideoNeedsReview(jobId: string, reasonCode: string, now = new Date()) {
	return db.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`video-v1:${jobId}`}, 0))`;
		const changed = await tx.videoExecution.updateMany({
			where: { jobId, stage: { notIn: [...TERMINAL] }, job: { executionEngine: ENGINE } },
			data: {
				stage: "NEEDS_REVIEW",
				needsReviewReason: reasonCode,
				lastProgressAt: now,
				stateVersion: { increment: 1 },
			},
		});
		if (changed.count)
			await tx.generationJob.updateMany({
				where: {
					id: jobId,
					executionEngine: ENGINE,
					status: { notIn: ["SUCCEEDED", "FAILED", "CANCELED"] },
				},
				data: { status: "NEEDS_RECONCILIATION", version: { increment: 1 } },
			});
		return { changed: changed.count > 0 };
	});
}

export async function listVideoRecoveryCandidates(limit: number, now = new Date()) {
	return db.videoExecution.findMany({
		where: {
			job: { executionEngine: ENGINE },
			stage: { notIn: [...TERMINAL] },
			OR: [
				{
					startState: { in: ["PENDING", "FAILED"] },
					OR: [{ nextStartAt: null }, { nextStartAt: { lte: now } }],
				},
				{
					startState: "STARTED",
					lastProgressAt: { lte: new Date(now.getTime() - 120_000) },
					OR: [{ nextStartAt: null }, { nextStartAt: { lte: now } }],
				},
			],
		},
		orderBy: [{ nextStartAt: "asc" }, { jobId: "asc" }],
		take: Math.min(100, Math.max(1, Math.floor(limit))),
		select: { jobId: true, workflowInstanceId: true, startState: true },
	});
}

export async function postponeVideoRecovery(jobId: string, now = new Date()) {
	await db.videoExecution.updateMany({
		where: { jobId, job: { executionEngine: ENGINE } },
		data: { nextStartAt: new Date(now.getTime() + 120_000) },
	});
}
