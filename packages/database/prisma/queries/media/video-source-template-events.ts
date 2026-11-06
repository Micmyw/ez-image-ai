import { createHash } from "node:crypto";

import { readSourceTemplateInternalRequest } from "@repo/config/video-template-execution.server";

import { getDatabaseClient } from "../../client";
import type { Prisma } from "../../generated/client";
import { runReadCommitted } from "./types";
import { lockSourceTemplateReviewContext } from "./video-source-template-review";

const ENGINE = "video-workflow-v1";
const terminal = new Set(["READY", "FAILED", "REJECTED", "NEEDS_REVIEW"]);
const acceptsPhase = (phase: SourceCallbackScope["phase"], stage: string) =>
	!terminal.has(stage) &&
	(phase === "input"
		? ["QUEUED", "INPUT_REVIEW"].includes(stage)
		: ["SUBMITTING", "SUBMISSION_UNCERTAIN", "GENERATING"].includes(stage));
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
export type SourceCallbackScope =
	| { phase: "generation"; jobId: string; attemptId: string }
	| { phase: "input"; jobId: string; role: string };

async function context(tx: Prisma.TransactionClient, scope: SourceCallbackScope) {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`video-v1:${scope.jobId}`}, 0))`;
	if (scope.phase === "input") {
		const { job, now, identities } = await lockSourceTemplateReviewContext(tx, scope.jobId);
		const identity = identities.find((item) => item.role === scope.role);
		const review = object(object(job.videoExecution!.stageData).inputReview);
		const role = object(object(review.roles)[scope.role]);
		if (
			!identity ||
			role.assetId !== identity.assetId ||
			role.checksum !== identity.checksum ||
			typeof role.callbackTokenHash !== "string"
		)
			throw new Error("SOURCE_CALLBACK_IDENTITY_INVALID");
		return {
			job,
			now,
			tokenHash: role.callbackTokenHash,
			provider: "source-video-input-seeapi",
			taskId: role.taskId,
			deadline: job.videoExecution!.inputReviewDeadlineAt,
		};
	}
	await tx.$queryRaw`SELECT "id" FROM "generation_job" WHERE "id" = ${scope.jobId} AND "executionEngine" = ${ENGINE} FOR UPDATE`;
	const job = await tx.generationJob.findFirst({
		where: { id: scope.jobId, executionEngine: ENGINE },
		include: { videoExecution: true, attempts: { orderBy: { attemptNumber: "desc" }, take: 1 } },
	});
	const attempt = job?.attempts[0];
	if (
		!job?.videoExecution ||
		!attempt ||
		attempt.id !== scope.attemptId ||
		!attempt.callbackTokenHash
	)
		throw new Error("SOURCE_CALLBACK_IDENTITY_INVALID");
	const source = readSourceTemplateInternalRequest(job.inputSnapshot).sourceTemplate.transport;
	if (source.provider !== attempt.provider || source.modelId !== attempt.providerModelId)
		throw new Error("SOURCE_CALLBACK_IDENTITY_INVALID");
	const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
	if (!clock) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
	return {
		job,
		now: clock.now,
		tokenHash: attempt.callbackTokenHash,
		provider: `source-video-generation-${source.provider}`,
		taskId: attempt.providerTaskId,
		deadline: job.videoExecution.providerDeadlineAt,
	};
}
function eventWhere(scope: SourceCallbackScope, value: Awaited<ReturnType<typeof context>>) {
	const ids = object(object(value.job.videoExecution!.stageData).sourceCallbackInbox)[
		value.tokenHash
	];
	return {
		id: { in: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [] },
		provider: value.provider,
		AND: [
			{ envelope: { path: ["jobId"], equals: scope.jobId } },
			{ envelope: { path: ["tokenHash"], equals: value.tokenHash } },
		],
	};
}

/** Dedicated durable inbox. No Outbox producer, global list, provider query, or financial mutation. */
export async function persistSourceTemplateCallback(input: {
	phase: "generation" | "input";
	provider: "kie" | "seeapi";
	tokenHash: string;
	jobId?: string;
	role?: string;
	rawBody: string;
	eventHash: string;
	receivedAt: Date;
}) {
	if (
		!/^[a-f0-9]{64}$/.test(input.tokenHash) ||
		Buffer.byteLength(input.rawBody) > 256 * 1024 ||
		createHash("sha256").update(input.rawBody).digest("hex") !== input.eventHash
	)
		throw new Error("SOURCE_CALLBACK_IDENTITY_INVALID");
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		let scope: SourceCallbackScope;
		if (input.phase === "generation") {
			const attempt = await tx.generationAttempt.findUnique({
				where: { callbackTokenHash: input.tokenHash },
			});
			if (!attempt) throw new Error("SOURCE_CALLBACK_IDENTITY_INVALID");
			scope = { phase: "generation", jobId: attempt.jobId, attemptId: attempt.id };
		} else {
			if (!input.jobId || !input.role || input.provider !== "seeapi")
				throw new Error("SOURCE_CALLBACK_IDENTITY_INVALID");
			scope = { phase: "input", jobId: input.jobId, role: input.role };
		}
		const value = await context(tx, scope);
		if (
			value.tokenHash !== input.tokenHash ||
			!value.provider.endsWith(`-${input.provider}`) ||
			value.job.videoExecution!.workflowInstanceId !== `video-v1-${scope.jobId}`
		)
			throw new Error("SOURCE_CALLBACK_IDENTITY_INVALID");
		// The body is evidence only. Even an early callback cannot supply a task ID or result URL.
		const providerEventId = `${input.tokenHash}:${input.eventHash}`;
		const prior = await tx.providerWebhookEvent.findUnique({
			where: { provider_providerEventId: { provider: value.provider, providerEventId } },
		});
		const inactive = !acceptsPhase(scope.phase, value.job.videoExecution!.stage);
		const event =
			prior ??
			(await tx.providerWebhookEvent.create({
				data: {
					provider: value.provider,
					providerEventId,
					providerTaskId: typeof value.taskId === "string" ? value.taskId : null,
					status: inactive ? "IGNORED" : "RECEIVED",
					verifiedAt: input.receivedAt,
					receivedAt: input.receivedAt,
					envelope: {
						executionEngine: ENGINE,
						...scope,
						tokenHash: input.tokenHash,
						workflowInstanceId: value.job.videoExecution!.workflowInstanceId,
						rawBody: input.rawBody,
						eventHash: input.eventHash,
						notifiedAt: null,
					},
				},
			}));
		if (!prior && !inactive) {
			const data = object(value.job.videoExecution!.stageData);
			const inbox = object(data.sourceCallbackInbox);
			const priorIds = Array.isArray(inbox[input.tokenHash])
				? (inbox[input.tokenHash] as string[])
				: [];
			if (priorIds.length >= 64) throw new Error("SOURCE_CALLBACK_INBOX_LIMIT");
			await tx.videoExecution.update({
				where: { jobId: scope.jobId },
				data: {
					stateVersion: { increment: 1 },
					stageData: {
						...data,
						sourceCallbackInbox: { ...inbox, [input.tokenHash]: [...priorIds, event.id] },
					} as Prisma.InputJsonObject,
				},
			});
		}
		return {
			eventId: event.id,
			jobId: scope.jobId,
			workflowInstanceId: value.job.videoExecution!.workflowInstanceId,
			phase: scope.phase,
			replayed: Boolean(prior),
			notified:
				inactive ||
				event.status !== "RECEIVED" ||
				typeof object(event.envelope).notifiedAt === "string",
		};
	});
}

export async function markSourceTemplateCallbackNotified(eventId: string) {
	await getDatabaseClient().$executeRaw`
		UPDATE "provider_webhook_event" SET "envelope" = "envelope" || jsonb_build_object('notifiedAt', clock_timestamp()::text)
		WHERE "id" = ${eventId} AND "provider" IN ('source-video-generation-kie', 'source-video-generation-seeapi', 'source-video-input-seeapi')`;
}

/** One authenticated read per distinct callback, claimed under the same job lock as submission. */
export async function claimSourceTemplateCallback(
	scope: SourceCallbackScope,
): Promise<string | null> {
	return runReadCommitted(getDatabaseClient(), async (tx) => {
		const value = await context(tx, scope);
		if (!acceptsPhase(scope.phase, value.job.videoExecution!.stage))
			throw new Error("SOURCE_CALLBACK_EXECUTION_HELD");
		if (value.deadline && value.deadline <= value.now) throw new Error("SOURCE_CALLBACK_DEADLINE");
		if (!value.taskId) return null;
		const where = eventWhere(scope, value);
		// An interrupted read cannot be reissued by a duplicate wake or an unrelated callback.
		if (
			await tx.providerWebhookEvent.findFirst({
				where: { ...where, status: { in: ["PROCESSING", "FAILED"] } },
			})
		)
			throw new Error("SOURCE_CALLBACK_CONFIRMATION_HELD");
		const event = await tx.providerWebhookEvent.findFirst({
			where: { ...where, status: "RECEIVED" },
			orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
		});
		if (!event) return null;
		const claimed = await tx.providerWebhookEvent.updateMany({
			where: { id: event.id, status: "RECEIVED" },
			data: { status: "PROCESSING", processingLeasedUntil: new Date(value.now.getTime() + 60_000) },
		});
		return claimed.count === 1 ? event.id : null;
	});
}

export async function finishSourceTemplateCallback(eventId: string, failed = false) {
	await getDatabaseClient().providerWebhookEvent.updateMany({
		where: {
			id: eventId,
			provider: {
				in: [
					"source-video-generation-kie",
					"source-video-generation-seeapi",
					"source-video-input-seeapi",
				],
			},
			status: "PROCESSING",
		},
		data: {
			status: failed ? "FAILED" : "PROCESSED",
			processedAt: new Date(),
			processingLeasedUntil: null,
			failureReason: failed ? "SOURCE_CALLBACK_CONFIRMATION_FAILED" : null,
		},
	});
}
