import type { Prisma } from "../../generated/client";
import type { MediaTransactionClient, OutboxClaimInput } from "./types";
import { runSerializable } from "./types";

interface ClaimedOutboxRow {
	id: string;
	eventType: string;
	aggregateType: string;
	aggregateId: string;
	dedupeKey: string;
	payload: Prisma.JsonValue;
	attempts: number;
	leaseToken: string;
	leasedUntil: Date;
}

export async function claimOutboxBatch(input: OutboxClaimInput, client: MediaTransactionClient) {
	if (input.limit < 1 || input.limit > 100) throw new Error("Outbox claim limit is invalid");
	if (input.leaseSeconds < 1) throw new Error("Outbox lease duration is invalid");
	const now = input.now ?? new Date();
	const leasedUntil = new Date(now.getTime() + input.leaseSeconds * 1_000);
	return runSerializable(
		client,
		(tx) =>
			tx.$queryRaw<ClaimedOutboxRow[]>`
			WITH claimable AS (
				SELECT "id"
				FROM "outbox_event"
				WHERE "availableAt" <= ${now}
				  AND (
					"status" = 'PENDING'
					OR ("status" = 'LEASED' AND "leasedUntil" <= ${now})
				  )
				ORDER BY "availableAt", "createdAt", "id"
				FOR UPDATE SKIP LOCKED
				LIMIT ${input.limit}
			)
			UPDATE "outbox_event" event
			SET "status" = 'LEASED', "leaseOwner" = ${input.workerId},
			    "leaseToken" = gen_random_uuid()::text,
			    "leasedUntil" = ${leasedUntil}, "attempts" = event."attempts" + 1
			FROM claimable
			WHERE event."id" = claimable."id"
			RETURNING event."id", event."eventType", event."aggregateType",
			          event."aggregateId", event."dedupeKey", event."payload",
			          event."attempts", event."leaseToken", event."leasedUntil"`,
	);
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
