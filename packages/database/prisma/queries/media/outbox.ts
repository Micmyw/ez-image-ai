import { Prisma } from "#prisma-runtime-client";

import type { OutboxEvent } from "../../generated/client";
import type { MediaTransactionClient, OutboxClaimInput } from "./types";
import { runSerializable } from "./types";

export interface ClaimedOutboxRow {
	id: string;
	eventType: string;
	aggregateType: string;
	aggregateId: string;
	dedupeKey: string;
	payload: Prisma.JsonValue;
	attempts: number;
	leaseToken: string;
	leasedUntil: Date;
	availableAt: Date;
}

export interface WorkflowOutboxReceipt {
	eventId: string;
	workerId: string;
	leaseToken: string;
}

export interface WorkflowOutboxExecutionReceipt extends WorkflowOutboxReceipt {
	/** Returned by begin; a late completion/clear/failure cannot mutate another execution. */
	executionMarker: string;
}

function assertExecutionMarker(marker: string) {
	if (!/^(EXECUTION_IN_PROGRESS|RECOVERY_QUERY_IN_PROGRESS):[0-9a-f-]{36}$/.test(marker))
		throw new Error("INVALID_OUTBOX_EXECUTION_GUARD");
}

function outboxClock(now?: Date): Prisma.Sql {
	return now === undefined ? Prisma.sql`clock_timestamp()` : Prisma.sql`${now}::timestamptz`;
}

export interface WorkflowOutboxPreparation {
	event: ClaimedOutboxRow | null;
	/** Remaining database time, never a cross-runtime absolute clock comparison. */
	retryAfterMs?: number;
}

/** Read-only recovery never claims an event or clears an uncertain execution guard. */
export async function readWorkflowOutboxEvent(
	eventId: string,
	client: MediaTransactionClient,
): Promise<OutboxEvent | null> {
	const [event] = await client.$queryRaw<OutboxEvent[]>`
		SELECT event.* FROM "outbox_event" event WHERE event."id" = ${eventId}
		AND ((event."aggregateType" = 'MEDIA_ASSET' AND event."eventType" IN ('MEDIA_ASSET_VERIFY', 'MEDIA_ASSET_MODERATION_REQUESTED')
		 AND (event."payload"->>'assetId' IS NULL OR event."payload"->>'assetId' = event."aggregateId"))
		 OR (event."aggregateType" = 'GENERATION_JOB' AND event."eventType" IN ('JOB_CREATED', 'GENERATION_DISPATCH', 'GENERATION_FINALIZE', 'GENERATION_FINALIZE_RETRY', 'GENERATION_SETTLE')
		 AND (event."payload"->>'jobId' IS NULL OR event."payload"->>'jobId' = event."aggregateId")))`;
	return event ?? null;
}

/** Legacy callers keep their row/null contract; new callers retain pending delivery. */
export async function prepareWorkflowOutboxEvent(
	input: { eventId: string; workerId: string; now?: Date },
	client: MediaTransactionClient,
): Promise<ClaimedOutboxRow | null> {
	return (await prepareWorkflowOutboxDelivery(input, client)).event;
}

/** Replaying a lost prepare response resumes only this Workflow's still-live lease. */
export async function prepareWorkflowOutboxDelivery(
	input: { eventId: string; workerId: string; now?: Date },
	client: MediaTransactionClient,
): Promise<WorkflowOutboxPreparation> {
	const claimed = await claimOutboxBatch(
		{
			workerId: input.workerId,
			eventIds: [input.eventId],
			limit: 1,
			leaseSeconds: 90,
			now: input.now,
		},
		client,
	);
	if (claimed[0]) return { event: claimed[0] };
	// The fallback also distinguishes a future due time or another live lease
	// from a terminal/missing event. A failed claim is never a completion receipt.
	const [observed] = await client.$queryRaw<Array<OutboxEvent & { observedAt: Date }>>`
		SELECT event.*, ${outboxClock(input.now)} AS "observedAt"
		FROM "outbox_event" event
		WHERE event."id" = ${input.eventId} AND event."status" IN ('PENDING', 'LEASED')
		AND ((event."aggregateType" = 'MEDIA_ASSET' AND event."eventType" IN ('MEDIA_ASSET_VERIFY', 'MEDIA_ASSET_MODERATION_REQUESTED')
		 AND (event."payload"->>'assetId' IS NULL OR event."payload"->>'assetId' = event."aggregateId"))
		 OR (event."aggregateType" = 'GENERATION_JOB' AND event."eventType" IN ('JOB_CREATED', 'GENERATION_DISPATCH', 'GENERATION_FINALIZE', 'GENERATION_FINALIZE_RETRY', 'GENERATION_SETTLE')
		 AND (event."payload"->>'jobId' IS NULL OR event."payload"->>'jobId' = event."aggregateId")))`;
	if (!observed) return { event: null };
	const { observedAt, ...event } = observed;
	const ownedLease = Boolean(
		event.status === "LEASED" &&
		event.leaseOwner === input.workerId &&
		event.leaseToken &&
		event.leasedUntil &&
		event.leasedUntil > observedAt,
	);
	if (ownedLease && event.availableAt <= observedAt)
		return { event: { ...event, leaseToken: event.leaseToken!, leasedUntil: event.leasedUntil! } };
	if (event.status === "LEASED" && !event.leasedUntil) return { event: null };
	return {
		event: null,
		retryAfterMs: Math.max(
			0,
			event.availableAt.getTime() - observedAt.getTime(),
			event.status === "LEASED" && !ownedLease
				? event.leasedUntil!.getTime() - observedAt.getTime()
				: 0,
		),
	};
}

/** Capacity waiting happens before this call; only the admitted task extends its own fence. */
export async function beginWorkflowOutboxExecution(
	input: WorkflowOutboxReceipt & {
		timeoutSeconds: number;
		now?: Date;
		allowQueryRecovery?: boolean;
		/** Same-request fused callers may reuse this observation for the outer engine gate only. */
		observeExecutionEngine?: boolean;
	},
	client: MediaTransactionClient,
) {
	if (
		!Number.isSafeInteger(input.timeoutSeconds) ||
		input.timeoutSeconds < 1 ||
		input.timeoutSeconds > 900
	)
		throw new Error("INVALID_OUTBOX_EXECUTION_TIMEOUT");
	const clock = outboxClock(input.now);
	const engineProjection =
		input.observeExecutionEngine === true
			? Prisma.sql`, CASE
			WHEN event."aggregateType" = 'MEDIA_ASSET' AND event."eventType" IN ('MEDIA_ASSET_VERIFY', 'MEDIA_ASSET_MODERATION_REQUESTED')
				THEN (SELECT asset."verificationEngine" FROM "media_asset" asset WHERE asset."id" = event."aggregateId")
			WHEN event."aggregateType" = 'GENERATION_JOB' AND event."eventType" IN ('JOB_CREATED', 'GENERATION_DISPATCH')
				THEN (SELECT job."executionEngine" FROM "generation_job" job WHERE job."id" = event."aggregateId")
			ELSE NULL END AS "observedExecutionEngine"`
			: Prisma.empty;
	const renewed = await client.$queryRaw<
		Array<OutboxEvent & { observedExecutionEngine?: string | null }>
	>`
		UPDATE "outbox_event" event
		SET "leasedUntil" = ${clock} + ${input.timeoutSeconds + 30} * INTERVAL '1 second',
			"lastError" = (CASE WHEN event."lastError" = 'RECOVERY_REQUIRED'
				THEN 'RECOVERY_QUERY_IN_PROGRESS:' ELSE 'EXECUTION_IN_PROGRESS:' END) || gen_random_uuid()::text
		WHERE event."id" = ${input.eventId} AND event."status" = 'LEASED'
		AND event."leaseOwner" = ${input.workerId} AND event."leaseToken" = ${input.leaseToken}
		AND event."leasedUntil" > ${clock}
		AND (event."lastError" IS NULL OR split_part(event."lastError", ':', 1) NOT IN ('RECOVERY_REQUIRED', 'EXECUTION_IN_PROGRESS', 'RECOVERY_QUERY_IN_PROGRESS')
			OR (${input.allowQueryRecovery === true} AND event."lastError" = 'RECOVERY_REQUIRED' AND event."aggregateType" = 'MEDIA_ASSET'
				AND event."eventType" IN ('MEDIA_ASSET_VERIFY', 'MEDIA_ASSET_MODERATION_REQUESTED')))
		RETURNING event.* ${engineProjection}`;
	if (renewed[0]) {
		const { observedExecutionEngine, ...event } = renewed[0];
		return {
			state: "active" as const,
			event,
			...(input.observeExecutionEngine === true
				? {
						engineObservation: {
							aggregateType: event.aggregateType,
							aggregateId: event.aggregateId,
							engine: observedExecutionEngine ?? null,
						},
					}
				: {}),
		};
	}
	// The common path is one conditional UPDATE RETURNING. Only lost-response
	// replay needs another read, and a completed row never reruns business code.
	const event = await client.outboxEvent.findFirst({
		where: { id: input.eventId, status: "PROCESSED" },
	});
	if (event) return { state: "completed" as const, event };
	const [held] = await client.$queryRaw<OutboxEvent[]>`
		SELECT event.* FROM "outbox_event" event
		WHERE event."id" = ${input.eventId} AND event."status" = 'LEASED'
		AND event."leaseOwner" = ${input.workerId} AND event."leaseToken" = ${input.leaseToken}
		AND event."leasedUntil" > ${clock}
		AND split_part(event."lastError", ':', 1) IN ('RECOVERY_REQUIRED', 'EXECUTION_IN_PROGRESS', 'RECOVERY_QUERY_IN_PROGRESS')`;
	return held
		? { state: "recovery-required" as const, event: held }
		: { state: "lost" as const, event: null };
}

/** A successful task is the receipt; Workflow creation or PENDING is never sufficient. */
export async function completeWorkflowOutboxExecution(
	input: WorkflowOutboxReceipt & { now?: Date; executionMarker?: string },
	client: MediaTransactionClient,
): Promise<boolean> {
	const clock = outboxClock(input.now);
	const count = await client.$executeRaw`
		UPDATE "outbox_event" event
		SET "status" = 'PROCESSED', "processedAt" = ${clock},
		    "leaseOwner" = NULL, "leaseToken" = NULL, "leasedUntil" = NULL,
			"lastError" = CASE WHEN split_part(event."lastError", ':', 1) IN ('RECOVERY_REQUIRED', 'EXECUTION_IN_PROGRESS', 'RECOVERY_QUERY_IN_PROGRESS')
				THEN NULL ELSE event."lastError" END
		WHERE event."id" = ${input.eventId} AND event."status" = 'LEASED'
		AND event."leaseOwner" = ${input.workerId} AND event."leaseToken" = ${input.leaseToken}
		AND event."leasedUntil" > ${clock}
		AND ((${input.executionMarker ?? null}::text IS NULL
			AND (event."lastError" IS NULL OR split_part(event."lastError", ':', 1) NOT IN ('RECOVERY_REQUIRED', 'EXECUTION_IN_PROGRESS', 'RECOVERY_QUERY_IN_PROGRESS')))
			OR event."lastError" = ${input.executionMarker ?? null})`;
	return count === 1;
}

/** Only a confirmed safe continuation may release this execution guard, never its lease. */
export async function deferWorkflowOutboxExecution(
	input: WorkflowOutboxExecutionReceipt & { now?: Date },
	client: MediaTransactionClient,
): Promise<boolean> {
	assertExecutionMarker(input.executionMarker);
	const clock = outboxClock(input.now);
	const count = await client.$executeRaw`
		UPDATE "outbox_event" event
		SET "lastError" = CASE WHEN split_part(event."lastError", ':', 1) = 'RECOVERY_QUERY_IN_PROGRESS'
			THEN 'RECOVERY_REQUIRED' ELSE NULL END
		WHERE event."id" = ${input.eventId} AND event."status" = 'LEASED'
		AND event."leaseOwner" = ${input.workerId} AND event."leaseToken" = ${input.leaseToken}
		AND event."leasedUntil" > ${clock}
		AND event."lastError" = ${input.executionMarker}`;
	return count === 1;
}

/** Preserve the current fence for recovery; failure is never an ACK or permission to replay. */
export async function failWorkflowOutboxExecution(
	input: WorkflowOutboxExecutionReceipt & { now?: Date },
	client: MediaTransactionClient,
): Promise<boolean> {
	assertExecutionMarker(input.executionMarker);
	const clock = outboxClock(input.now);
	const count = await client.$executeRaw`
		UPDATE "outbox_event" event
		SET "lastError" = 'RECOVERY_REQUIRED'
		WHERE event."id" = ${input.eventId} AND event."status" = 'LEASED'
		AND event."leaseOwner" = ${input.workerId} AND event."leaseToken" = ${input.leaseToken}
		AND event."leasedUntil" > ${clock} AND event."lastError" = ${input.executionMarker}`;
	return count === 1;
}

export async function claimOutboxBatch(
	input: OutboxClaimInput,
	client: MediaTransactionClient | Prisma.TransactionClient,
) {
	if (input.limit < 1 || input.limit > 100) throw new Error("Outbox claim limit is invalid");
	if (input.leaseSeconds < 1) throw new Error("Outbox lease duration is invalid");
	if (
		input.eventIds !== undefined &&
		(input.outputReviewEventId !== undefined ||
			input.eventIds.length < 1 ||
			input.eventIds.length > 100 ||
			input.eventIds.some((id) => !id || id.length > 256))
	)
		throw new Error("Invalid continuation events");
	const clock = outboxClock(input.now);
	const target =
		input.eventIds !== undefined
			? Prisma.sql`AND "id" IN (${Prisma.join(input.eventIds)})
		AND (("aggregateType" = 'MEDIA_ASSET' AND "eventType" IN ('MEDIA_ASSET_VERIFY', 'MEDIA_ASSET_MODERATION_REQUESTED')
		 AND ("payload"->>'assetId' IS NULL OR "payload"->>'assetId' = "aggregateId"))
		 OR ("aggregateType" = 'GENERATION_JOB' AND "eventType" IN ('JOB_CREATED', 'GENERATION_DISPATCH', 'GENERATION_FINALIZE', 'GENERATION_FINALIZE_RETRY', 'GENERATION_SETTLE')
		 AND ("payload"->>'jobId' IS NULL OR "payload"->>'jobId' = "aggregateId")))`
			: input.outputReviewEventId === undefined
				? Prisma.empty
				: Prisma.sql`
		AND "id" = ${input.outputReviewEventId}
		AND "eventType" = 'MEDIA_ASSET_VERIFY' AND "aggregateType" = 'MEDIA_ASSET'
		AND ("payload"->>'assetId' IS NULL OR "payload"->>'assetId' = "aggregateId")
		AND EXISTS (SELECT 1 FROM "media_asset" asset
			WHERE asset."id" = "outbox_event"."aggregateId" AND asset."kind" = 'OUTPUT'
			AND asset."mimeType" LIKE 'image/%')`;
	const claim = (tx: Prisma.TransactionClient) =>
		tx.$queryRaw<ClaimedOutboxRow[]>`
			WITH tick AS MATERIALIZED (SELECT ${clock} AS "now"), claimable AS (
				SELECT "id"
				FROM "outbox_event", tick
				WHERE "availableAt" <= tick."now"
				  ${target}
				  AND (
					"status" = 'PENDING'
					OR ("status" = 'LEASED' AND "leasedUntil" <= tick."now")
				  )
				ORDER BY "availableAt", "createdAt", "id"
				FOR UPDATE OF "outbox_event" SKIP LOCKED
				LIMIT ${input.limit}
			)
			UPDATE "outbox_event" event
			SET "status" = 'LEASED', "leaseOwner" = ${input.workerId},
			    "leaseToken" = gen_random_uuid()::text,
			    "lastError" = CASE WHEN split_part(event."lastError", ':', 1) IN ('RECOVERY_REQUIRED', 'EXECUTION_IN_PROGRESS', 'RECOVERY_QUERY_IN_PROGRESS') THEN NULL ELSE event."lastError" END,
				    "leasedUntil" = (SELECT "now" FROM tick) + ${input.leaseSeconds} * INTERVAL '1 second',
				    "attempts" = event."attempts" + 1
			FROM claimable
			WHERE event."id" = claimable."id"
			RETURNING event."id", event."eventType", event."aggregateType",
			          event."aggregateId", event."dedupeKey", event."payload",
			          event."attempts", event."leaseToken", event."leasedUntil", event."availableAt"`;
	// Exact event IDs need no cross-statement snapshot: this statement selects,
	// locks and updates the same rows atomically. Keep any caller-owned transaction
	// intact, and retain Serializable scanning/legacy output-review semantics.
	if (input.eventIds !== undefined || !("$transaction" in client)) return claim(client);
	return runSerializable(client as MediaTransactionClient, claim);
}

export async function completeOutboxEvent(
	id: string,
	workerId: string,
	leaseToken: string,
	client: MediaTransactionClient,
) {
	return client.outboxEvent.updateMany({
		where: { id, status: "LEASED", leaseOwner: workerId, leaseToken },
		data: {
			status: "PROCESSED",
			processedAt: new Date(),
			leaseOwner: null,
			leaseToken: null,
			leasedUntil: null,
		},
	});
}

export async function deferOutboxEvent(
	input: { id: string; workerId: string; leaseToken: string; retryAt: Date; now?: Date },
	client: MediaTransactionClient,
): Promise<{ applied: boolean }> {
	const applied = await client.outboxEvent.updateMany({
		where: {
			id: input.id,
			status: "LEASED",
			leaseOwner: input.workerId,
			leaseToken: input.leaseToken,
			leasedUntil: { gt: input.now ?? new Date() },
			attempts: { gt: 0 },
		},
		data: {
			status: "PENDING",
			availableAt: input.retryAt,
			// Polling an accepted Workflow is the same delivery, not a failed retry.
			attempts: { decrement: 1 },
			leaseOwner: null,
			leaseToken: null,
			leasedUntil: null,
		},
	});
	return { applied: applied.count === 1 };
}

export async function releaseOutboxEvent(
	input: {
		id: string;
		workerId: string;
		leaseToken: string;
		error: string;
		maxAttempts: number;
		retryAt: Date;
	},
	client: MediaTransactionClient,
) {
	return runSerializable(client, async (tx) => {
		const event = await tx.outboxEvent.findFirst({
			where: {
				id: input.id,
				status: "LEASED",
				leaseOwner: input.workerId,
				leaseToken: input.leaseToken,
			},
		});
		if (!event) return { applied: false, deadLettered: false };
		const deadLettered = event.attempts >= input.maxAttempts;
		const applied = await tx.outboxEvent.updateMany({
			where: {
				id: event.id,
				status: "LEASED",
				leaseOwner: input.workerId,
				leaseToken: input.leaseToken,
			},
			data: {
				status: deadLettered ? "DEAD_LETTER" : "PENDING",
				lastError: input.error,
				availableAt: input.retryAt,
				leaseOwner: null,
				leaseToken: null,
				leasedUntil: null,
			},
		});
		return { applied: applied.count === 1, deadLettered: applied.count === 1 && deadLettered };
	});
}
